import XCTest
import AppKit
import SwiftUI
import TodoCueKit
@testable import TodoCue

final class DragMotionTests: XCTestCase {
    private func row(_ id: String, y: CGFloat, height: CGFloat = 48, group: String = "A", surface: DragSurface = .list(.all)) -> TaskDragFrame {
        TaskDragFrame(slot: TaskDragSlot(surface: surface, group: group, kind: .row, taskID: id),
                      rect: CGRect(x: 0, y: y, width: 270, height: height))
    }
    private func end(y: CGFloat, group: String = "A", surface: DragSurface = .list(.all)) -> TaskDragFrame {
        TaskDragFrame(slot: TaskDragSlot(surface: surface, group: group, kind: .end), rect: CGRect(x: 0, y: y, width: 270, height: 10))
    }

    func testMovingUpMakesExactlyTheInterveningRowsGiveWay() {
        let a = row("a", y: 0), b = row("b", y: 50), c = row("c", y: 100), d = row("d", y: 150)
        let projection = TaskDragProjection.evaluate(frames: [a, b, c, d, end(y: 200)], source: c.slot,
                                                      target: TaskDropTarget(surface: .list(.all), group: "A", beforeId: "a"))
        XCTAssertEqual(projection.offsets, [a.slot: 50, b.slot: 50])
        XCTAssertEqual(projection.landingOffset, CGSize(width: 0, height: -100))
        // No collisions in the projected final order C, A, B, D.
        XCTAssertEqual(c.rect.minY + projection.landingOffset.height, 0)
        XCTAssertEqual(a.rect.minY + projection.offsets[a.slot]!, 50)
        XCTAssertEqual(b.rect.minY + projection.offsets[b.slot]!, 100)
    }

    func testMovingDownUsesDraggedRowHeightAndPreservesVariableHeightRows() {
        let a = row("a", y: 0, height: 80), b = row("b", y: 82, height: 35), c = row("c", y: 119, height: 60)
        let projection = TaskDragProjection.evaluate(frames: [a, b, c, end(y: 181)], source: a.slot,
                                                      target: TaskDropTarget(surface: .list(.all), group: "A", beforeId: nil))
        XCTAssertEqual(projection.offsets, [b.slot: -82, c.slot: -82])
        XCTAssertEqual(projection.landingOffset.height, 99)
        XCTAssertEqual(c.rect.maxY + projection.offsets[c.slot]! + 2, projection.landingOffset.height)
    }

    func testReturningAcrossSameBoundaryIsReversibleAndDoesNotAccumulateOffsets() {
        let a = row("a", y: 0), b = row("b", y: 50), c = row("c", y: 100)
        let frames = [a, b, c, end(y: 150)]
        let beforeA = TaskDropTarget(surface: .list(.all), group: "A", beforeId: "a")
        let first = TaskDragProjection.evaluate(frames: frames, source: b.slot, target: beforeA)
        _ = TaskDragProjection.evaluate(frames: frames, source: b.slot, target: TaskDropTarget(surface: .list(.all), group: "A", beforeId: nil))
        XCTAssertEqual(TaskDragProjection.evaluate(frames: frames, source: b.slot, target: beforeA), first)
        XCTAssertEqual(TaskDragProjection.evaluate(frames: frames, source: b.slot, target: TaskDropTarget(surface: .list(.all), group: "A", beforeId: "b")), TaskDragProjection())
        XCTAssertEqual(TaskDragProjection.evaluate(frames: frames, source: b.slot, target: nil), TaskDragProjection())
    }

    func testCrossProjectMovesIntermediateHeadersAndOpensAnEmptyGroup() {
        let a = row("a", y: 0), sourceEnd = end(y: 50)
        let header = TaskDragFrame(slot: TaskDragSlot(surface: .list(.all), group: "B", kind: .header), rect: CGRect(x: 0, y: 70, width: 270, height: 20))
        let targetEnd = end(y: 92, group: "B")
        let projection = TaskDragProjection.evaluate(frames: [a, sourceEnd, header, targetEnd], source: a.slot,
                                                      target: TaskDropTarget(surface: .list(.all), group: "B", beforeId: nil))
        XCTAssertEqual(projection.offsets[header.slot], -50)
        XCTAssertEqual(projection.landingOffset.height, 42)
        XCTAssertEqual(header.rect.maxY + projection.offsets[header.slot]! + 2, projection.landingOffset.height)
    }

    func testForbiddenTodayGroupNeverMakesSpace() {
        let a = row("a", y: 0, group: "overdue", surface: .list(.today))
        let b = row("b", y: 50, group: "scheduled", surface: .list(.today))
        XCTAssertEqual(TaskDragProjection.evaluate(frames: [a, b], source: a.slot,
                                                   target: TaskDropTarget(surface: .list(.today), group: "scheduled", beforeId: "b")), TaskDragProjection())
    }

    @MainActor func testTwoPointGutterDoesNotCollapseTheInsertionGap() {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 300), styleMask: [], backing: .buffered, defer: false)
        let first = TaskDropRegion.RegionView(frame: NSRect(x: 0, y: 150, width: 270, height: 48))
        first.target = TaskDropTarget(surface: .list(.all), group: "A", beforeId: "a"); first.afterId = "b"; first.isRow = true
        let second = TaskDropRegion.RegionView(frame: NSRect(x: 0, y: 100, width: 270, height: 48))
        second.target = TaskDropTarget(surface: .list(.all), group: "A", beforeId: "b"); second.isRow = true
        window.contentView!.addSubview(first); window.contentView!.addSubview(second)
        XCTAssertEqual(TaskDropRegion.RegionView.target(at: NSPoint(x: 30, y: 149), in: window, surface: .list(.all))?.beforeId, "b")
        XCTAssertNil(TaskDropRegion.RegionView.target(at: NSPoint(x: 30, y: 80), in: window, surface: .list(.all)))
    }

    @MainActor func testHostedPreviewKeepsMeasurementsFixedWhileRowsVisuallyGiveWay() async throws {
        _ = NSApplication.shared
        let model = AppModel(client: APIClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "fixture"))
        let tasks = ["整理今天的工作", "检查项目进度", "准备明天的会议"].enumerated().map { index, title in
            TodoTask(id: "motion-\(index)", title: title, project: "工作", timezone: "Asia/Shanghai",
                     createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z")
        }
        let root = VStack(spacing: 2) {
            DraggableSectionHeader(title: "工作", count: 3, view: .all, group: "工作", firstId: tasks[0].id)
            ForEach(Array(tasks.enumerated()), id: \.element.id) { index, task in
                DraggableTaskRow(task: task, surface: .list(.all), group: "工作", nextId: index < 2 ? tasks[index + 1].id : nil, showProject: false)
            }
            TaskGroupEnd(view: .all, group: "工作")
        }.padding(20).frame(width: 340, height: 300, alignment: .top).background(Color(nsColor: .windowBackgroundColor)).environmentObject(model)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 340, height: 300), styleMask: [], backing: .buffered, defer: false)
        let hosting = NSHostingView(rootView: root)
        window.contentView = hosting
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(nanoseconds: 30_000_000)
        let before = TaskDropRegion.RegionView.frames(in: window, surface: .list(.all)).sorted { $0.rect.minY < $1.rect.minY }
        let first = try XCTUnwrap(before.first { $0.slot.taskID == tasks[0].id })
        let source = try XCTUnwrap(before.first { $0.slot.taskID == tasks[2].id })
        func evidence(_ name: String) throws {
            guard let directory = ProcessInfo.processInfo.environment["TODOCUE_DRAG_EVIDENCE_DIR"] else { return }
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let bitmap = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
        }
        var frame = 0
        let recording = ProcessInfo.processInfo.environment["TODOCUE_DRAG_EVIDENCE_DIR"] != nil
        func recordFrame() throws {
            try evidence(String(format: "frame-%03d", frame)); frame += 1
        }
        try evidence("01-rest")
        if recording { for _ in 0..<12 { try recordFrame() } }
        XCTAssertTrue(model.beginTaskDrag(tasks[2], surface: .list(.all), group: "工作"))
        let origin = NSPoint(x: source.rect.minX + 10, y: -source.rect.minY - 12)
        let pointer = NSPoint(x: first.rect.minX + 18, y: -first.rect.minY - 16)
        if recording {
            for step in 1...30 {
                let t = CGFloat(step) / 30
                let position = NSPoint(x: origin.x + (pointer.x - origin.x) * t, y: origin.y + (pointer.y - origin.y) * t)
                model.updateTaskDrag(at: position, origin: origin, in: window)
                try await Task.sleep(nanoseconds: 33_333_333)
                try recordFrame()
            }
        } else { model.updateTaskDrag(at: pointer, origin: origin, in: window) }
        try await Task.sleep(nanoseconds: 250_000_000)
        hosting.layoutSubtreeIfNeeded()
        let during = TaskDropRegion.RegionView.frames(in: window, surface: .list(.all)).sorted { $0.rect.minY < $1.rect.minY }
        XCTAssertEqual(during, before, "Visual transforms must never feed back into collision measurements")
        XCTAssertEqual(model.dragPresentation?.projection.offsets[first.slot], source.rect.height + 2)
        try evidence("02-give-way")
        if recording { for _ in 0..<12 { try recordFrame() } }
        model.handleEscape()
        if recording {
            for _ in 0..<10 { try await Task.sleep(nanoseconds: 33_333_333); try recordFrame() }
        } else { try await Task.sleep(nanoseconds: 250_000_000) }
        hosting.layoutSubtreeIfNeeded()
        XCTAssertNil(model.dragPresentation)
        try evidence("03-return")
        if recording { for _ in 0..<12 { try recordFrame() } }
    }

    @MainActor func testPointerRemainsAttachedWhenScrollMovesUnderlyingRowsAndCancelRestoresThem() async throws {
        _ = NSApplication.shared
        let model = AppModel(client: APIClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "fixture"))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 300), styleMask: [], backing: .buffered, defer: false)
        let a = TaskDropRegion.RegionView(frame: NSRect(x: 0, y: 150, width: 270, height: 48))
        a.target = TaskDropTarget(surface: .list(.all), group: "A", beforeId: "a"); a.afterId = "b"; a.isRow = true
        let b = TaskDropRegion.RegionView(frame: NSRect(x: 0, y: 100, width: 270, height: 48))
        b.target = TaskDropTarget(surface: .list(.all), group: "A", beforeId: "b"); b.isRow = true
        window.contentView!.addSubview(a); window.contentView!.addSubview(b)
        let task = TodoTask(id: "b", title: "不会写入数据库", timezone: "Asia/Shanghai", createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z")
        XCTAssertTrue(model.beginTaskDrag(task, surface: .list(.all), group: "A"))
        let origin = b.convert(NSPoint(x: 10, y: 10), to: nil)
        let pointer = a.convert(NSPoint(x: 10, y: 10), to: nil)
        model.updateTaskDrag(at: pointer, origin: origin, in: window)
        let presentation = try XCTUnwrap(model.dragPresentation)
        XCTAssertEqual(presentation.translation.height, -50)
        XCTAssertEqual(presentation.projection.offsets[TaskDragSlot(surface: .list(.all), group: "A", kind: .row, taskID: "a")], 50)
        // Scroll the original measurement slots, not the visual transforms.
        b.frame.origin.y += 20; a.frame.origin.y += 20
        model.updateTaskDrag(at: pointer, origin: origin, in: window)
        XCTAssertEqual(model.dragPresentation?.translation.height, -30)
        XCTAssertEqual(model.dragPresentation?.grabOffset, presentation.grabOffset)
        XCTAssertFalse(model.isMovingTask)
        XCTAssertTrue(model.allTasks.isEmpty) // Preview has not mutated the data snapshot.
        model.handleEscape()
        XCTAssertEqual(model.dragPresentation?.phase, .returning)
        XCTAssertEqual(model.dragPresentation?.translation, .zero)
        XCTAssertEqual(model.dragPresentation?.projection, TaskDragProjection())
        XCTAssertNil(model.draggedTask)
        XCTAssertFalse(model.isMovingTask)
    }
}
