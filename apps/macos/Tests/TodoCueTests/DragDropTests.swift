import XCTest
import AppKit
import TodoCueKit
@testable import TodoCue

final class DragDropTests: XCTestCase {
    private func task(status: TaskStatus = .todo) -> TodoTask {
        TodoTask(id: "fixture", title: "测试", project: "A", timezone: "Asia/Shanghai", status: status,
                 createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z")
    }
    @MainActor private func model() -> AppModel {
        // This client is only used to enable local drag state; these tests never submit a move.
        AppModel(client: APIClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "fixture"))
    }

    @MainActor func testOfflineCompletedAndPendingConfirmationCannotStartDragging() {
        XCTAssertFalse(AppModel().beginTaskDrag(task(), view: .all, group: "A"))
        let model = model()
        XCTAssertFalse(model.beginTaskDrag(task(status: .done), view: .all, group: "A"))
        model.pendingMove = PendingTaskMove(drag: TaskDrag(task: task(), view: .all, group: "A", revision: 0),
                                           target: TaskDropTarget(view: .all, group: "B", beforeId: nil))
        XCTAssertFalse(model.beginTaskDrag(task(), view: .all, group: "A"))
    }

    @MainActor func testTodayCrossGroupIsForbiddenAndEscapeCancelsWithoutClosingPanel() {
        let model = model()
        var closes = 0
        model.onClosePanel = { closes += 1 }
        XCTAssertTrue(model.beginTaskDrag(task(), view: .today, group: "2026-09-08:overdue"))
        let target = TaskDropTarget(view: .today, group: "2026-09-08:scheduled", beforeId: nil)
        model.dropTarget = target
        XCTAssertEqual(model.dragHint, L10n.tr("此分组由截止日期决定，请编辑日期"))
        XCTAssertFalse(model.dropTask(at: target))
        XCTAssertFalse(model.dropTask(at: TaskDropTarget(view: .all, group: "A", beforeId: nil)))
        model.handleEscape()
        XCTAssertNil(model.draggedTask)
        XCTAssertNil(model.dropTarget)
        XCTAssertEqual(closes, 0)
        XCTAssertFalse(model.isMovingTask)
        XCTAssertFalse(model.dropTask(at: target))
    }

    func testMovePayloadContainsSnapshotAndOnlyExplicitlyConfirmsDeadline() throws {
        let move = PendingTaskMove(drag: TaskDrag(task: task(), view: .upcoming, group: "2026-09-09", revision: 42),
                                   target: TaskDropTarget(view: .upcoming, group: "2026-09-10", beforeId: nil))
        let data = try JSONEncoder().encode(move.payload(allowPastDeadline: false).fields)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["expectedRevision"] as? Int, 42)
        XCTAssertEqual(json["expectedVersion"] as? Int, 1)
        XCTAssertEqual(json["allowPastDeadline"] as? Bool, false)
        XCTAssertTrue(json["beforeId"] is NSNull)
        XCTAssertNil(json["dueDate"])
        XCTAssertNil(json["reminderAt"])
        XCTAssertNil(json["priority"])
    }

    @MainActor func testDropRegionsRejectOutsideBoundsAndResolveTopBottomAndEmptyGroup() {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 300), styleMask: [], backing: .buffered, defer: false)
        let row = TaskDropRegion.RegionView(frame: NSRect(x: 10, y: 100, width: 250, height: 50))
        row.target = TaskDropTarget(view: .all, group: "A", beforeId: "first")
        row.afterId = "second"; row.isRow = true
        window.contentView!.addSubview(row)
        let outside = row.convert(NSPoint(x: 30, y: -30), to: nil)
        XCTAssertNil(TaskDropRegion.RegionView.target(at: outside, in: window, view: .all))
        let top = row.convert(NSPoint(x: 30, y: 10), to: nil)
        let bottom = row.convert(NSPoint(x: 30, y: 40), to: nil)
        XCTAssertEqual(TaskDropRegion.RegionView.target(at: top, in: window, view: .all)?.beforeId, "first")
        XCTAssertEqual(TaskDropRegion.RegionView.target(at: bottom, in: window, view: .all)?.beforeId, "second")
        XCTAssertNil(TaskDropRegion.RegionView.target(at: top, in: window, view: .today))
        row.enabled = false
        XCTAssertNil(TaskDropRegion.RegionView.target(at: top, in: window, view: .all))
        row.enabled = true; row.isRow = false
        row.target = TaskDropTarget(view: .all, group: "", beforeId: nil)
        XCTAssertEqual(TaskDropRegion.RegionView.target(at: top, in: window, view: .all), row.target)
        row.removeFromSuperview()
        XCTAssertNil(TaskDropRegion.RegionView.target(at: top, in: window, view: .all))
    }

    @MainActor func testClippedOffscreenRowsCannotReceiveADrop() {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 300), styleMask: [], backing: .buffered, defer: false)
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 250, height: 100))
        let document = NSView(frame: NSRect(x: 0, y: 0, width: 250, height: 600))
        scroll.documentView = document
        window.contentView!.addSubview(scroll)
        let row = TaskDropRegion.RegionView(frame: NSRect(x: 0, y: 300, width: 200, height: 50))
        row.target = TaskDropTarget(view: .all, group: "A", beforeId: "hidden")
        document.addSubview(row)
        let point = row.convert(NSPoint(x: 20, y: 20), to: nil)
        XCTAssertNil(TaskDropRegion.RegionView.target(at: point, in: window, view: .all))
    }

    @MainActor func testEdgeScrollMovesWhilePointerStaysAtEdgeAndStopsAtContentBounds() {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 300), styleMask: [], backing: .buffered, defer: false)
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 250, height: 100))
        let document = NSView(frame: NSRect(x: 0, y: 0, width: 250, height: 600))
        scroll.documentView = document
        window.contentView!.addSubview(scroll)
        let handle = TaskDragHandle.HandleView(frame: NSRect(x: 0, y: 0, width: 16, height: 30))
        document.addSubview(handle)
        let clip = scroll.contentView
        clip.scroll(to: NSPoint(x: 0, y: 100))
        let edge = clip.convert(NSPoint(x: 50, y: clip.bounds.maxY - 5), to: nil)
        handle.scrollAtEdge(at: edge)
        XCTAssertGreaterThan(clip.bounds.minY, 100)
        for _ in 0..<100 { handle.scrollAtEdge(at: edge) }
        XCTAssertEqual(clip.bounds.minY, 500)
        let center = clip.convert(NSPoint(x: 50, y: clip.bounds.midY), to: nil)
        handle.scrollAtEdge(at: center)
        XCTAssertEqual(clip.bounds.minY, 500)
        let opposite = clip.convert(NSPoint(x: 50, y: clip.bounds.minY + 5), to: nil)
        for _ in 0..<100 { handle.scrollAtEdge(at: opposite) }
        XCTAssertEqual(clip.bounds.minY, 0)
    }

    func testPlanDateUsesTaskTimezoneAndPrefersPlanToDeadline() {
        var t = task()
        t.timezone = "America/Los_Angeles"
        t.scheduledAt = "2026-09-10T01:00:00.000Z"
        t.dueDate = "2026-09-08"
        XCTAssertEqual(t.planDate, "2026-09-09")
        t.scheduledAt = nil
        XCTAssertEqual(t.planDate, "2026-09-08")
    }
}
