import XCTest
import SwiftUI
import AppKit
import TodoCueKit
@testable import TodoCue

/// Drives the real drag lifecycle over a hosted calendar: pick up an agenda row, hover a day cell,
/// drop. The client points at a dead port, so the network half always fails — which is precisely
/// the path that must still leave the app usable.
final class CalendarDragTests: XCTestCase {
    private let today = TCDate.todayString()
    private var tomorrow: String { CivilDate.adding(1, to: today) }

    /// Polls instead of sleeping a fixed amount: the fixture request to a dead port resolves at
    /// very different speeds on a laptop and on a CI runner.
    @MainActor private func wait(upTo seconds: Double = 5, until done: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !done(), Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    private func task(_ id: String, on date: String) -> TodoTask {
        TodoTask(id: id, title: "写周报 \(id)", scheduledDate: date, timezone: "Asia/Shanghai",
                 createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z")
    }

    /// Hosts one draggable row for `today` and one drop target for `tomorrow`, and returns the
    /// window plus the measured frames once SwiftUI has laid them out.
    @MainActor private func host(_ model: AppModel) async throws -> NSWindow {
        let root = VStack(spacing: 2) {
            DraggableTaskRow(task: task("a", on: today), surface: .calendar, group: today,
                             nextId: nil, compact: true, reorderable: false)
            CalendarDropTarget(date: tomorrow).frame(height: 40)
        }
        .padding(20).frame(width: 340, height: 300, alignment: .top)
        .environmentObject(model)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 340, height: 300),
                              styleMask: [], backing: .buffered, defer: false)
        let hosting = NSHostingView(rootView: root)
        window.contentView = hosting
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(nanoseconds: 40_000_000)
        return window
    }

    /// A calendar drop used to park `dragPresentation` in `.landing` with nothing to clear it.
    /// `apply(_:)` and `beginTaskDrag` both refuse while one is set, so a single successful drag
    /// froze every board snapshot and every drag in the app until relaunch.
    @MainActor func testADropClearsTheDragPresentationSoTheAppKeepsWorking() async throws {
        _ = NSApplication.shared
        let model = AppModel(client: APIClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "fixture"))
        let window = try await host(model)
        let hosting = try XCTUnwrap(window.contentView)

        let dragged = task("a", on: today)
        XCTAssertTrue(model.beginTaskDrag(dragged, surface: .calendar, group: today))
        // The day cell only registers its region once a drag is in flight.
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(nanoseconds: 40_000_000)

        let frames = TaskDropRegion.RegionView.frames(in: window, surface: .calendar)
        let source = try XCTUnwrap(frames.first { $0.slot.taskID == dragged.id })
        let day = try XCTUnwrap(frames.first { $0.slot.group == self.tomorrow })
        let origin = NSPoint(x: source.rect.minX + 10, y: -source.rect.minY - 12)
        let pointer = NSPoint(x: day.rect.midX, y: -day.rect.midY)
        model.updateTaskDrag(at: pointer, origin: origin, in: window)

        XCTAssertEqual(model.dropTarget?.group, tomorrow, "the day under the pointer must be the target")
        XCTAssertNotNil(model.dragPresentation)
        XCTAssertTrue(model.dropTask(at: try XCTUnwrap(model.dropTarget)))
        model.endTaskDrag()

        // Settling is animated, and the request has to fail, before the state is final.
        try await wait { model.dragPresentation == nil && !model.isMovingTask }

        // These are exactly the guards the leak tripped: `apply(_:)` drops every snapshot while a
        // presentation is set, and `beginTaskDrag` refuses while either that or `isMovingTask` is.
        XCTAssertNil(model.dragPresentation, "a leaked presentation blocks every later snapshot and drag")
        XCTAssertNil(model.draggedTask)
        XCTAssertNil(model.dropTarget)
        XCTAssertFalse(model.isMovingTask, "the in-flight flag must clear even when the request fails")
        XCTAssertNil(model.pendingMove)
    }

    /// Hovering a day must not shuffle rows the way a list reorder does.
    @MainActor func testHoveringADayDoesNotDisplaceAnyRow() async throws {
        _ = NSApplication.shared
        let model = AppModel(client: APIClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "fixture"))
        let window = try await host(model)
        let hosting = try XCTUnwrap(window.contentView)
        let dragged = task("a", on: today)
        XCTAssertTrue(model.beginTaskDrag(dragged, surface: .calendar, group: today))
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(nanoseconds: 40_000_000)

        let frames = TaskDropRegion.RegionView.frames(in: window, surface: .calendar)
        let source = try XCTUnwrap(frames.first { $0.slot.taskID == dragged.id })
        let day = try XCTUnwrap(frames.first { $0.slot.group == self.tomorrow })
        model.updateTaskDrag(at: NSPoint(x: day.rect.midX, y: -day.rect.midY),
                             origin: NSPoint(x: source.rect.minX + 10, y: -source.rect.minY - 12),
                             in: window)
        XCTAssertEqual(model.dragPresentation?.projection.offsets, [:])
        XCTAssertEqual(model.dragPresentation?.projection.landingOffset, .zero)
        model.endTaskDrag()
    }

    /// The calendar row is measured so it can be lifted, but is never itself a landing place.
    @MainActor func testACalendarRowIsMeasuredButNotDroppable() async throws {
        _ = NSApplication.shared
        let model = AppModel(client: APIClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "fixture"))
        let window = try await host(model)
        let hosting = try XCTUnwrap(window.contentView)
        XCTAssertTrue(model.beginTaskDrag(task("a", on: today), surface: .calendar, group: today))
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(nanoseconds: 40_000_000)

        let frames = TaskDropRegion.RegionView.frames(in: window, surface: .calendar)
        let source = try XCTUnwrap(frames.first { $0.slot.taskID == "a" })
        XCTAssertNotNil(source, "the lifted row needs its own frame")
        let onItself = TaskDropRegion.RegionView.target(at: NSPoint(x: source.rect.midX, y: -source.rect.midY),
                                                        in: window, surface: .calendar)
        XCTAssertNotEqual(onItself?.group, today, "a row must not be a drop target")
        model.endTaskDrag()
    }
}
