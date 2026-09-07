import XCTest
import AppKit
import TodoCueKit
@testable import TodoCue

final class NotchTests: XCTestCase {
    private func task(_ id: String, scheduledAt: String? = nil, dueAt: String? = nil, status: TaskStatus = .todo) -> TodoTask {
        TodoTask(id: id, title: "任务 \(id)", scheduledAt: scheduledAt, dueAt: dueAt, timezone: "Asia/Shanghai",
                 status: status, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z")
    }

    private func item(_ id: String, _ section: TodaySection, status: TaskStatus = .todo) -> TodayItem {
        TodayItem(task: task(id, status: status), reasons: [], section: section)
    }

    func testCollapsedFrameWrapsNotchWithSlackAndWings() {
        let notch = CGRect(x: 771, y: 1085, width: 185, height: 32)
        let bare = NotchLayout.collapsedFrame(notch: notch, slack: 10, wing: 0)
        XCTAssertEqual(bare, CGRect(x: 761, y: 1085, width: 205, height: 32))
        let winged = NotchLayout.collapsedFrame(notch: notch, slack: 10, wing: 44)
        XCTAssertEqual(winged.minX, 717)
        XCTAssertEqual(winged.width, 293)
        XCTAssertEqual(winged.midX, notch.midX)
        XCTAssertEqual(winged.height, notch.height)
    }

    func testExpandedFrameHangsFromTopCenteredOnNotch() {
        let screen = CGRect(x: 0, y: 0, width: 1728, height: 1117)
        let notch = CGRect(x: 771, y: 1085, width: 185, height: 32)
        let frame = NotchLayout.expandedFrame(notch: notch, screen: screen, contentHeight: 300, width: 560, maxHeight: 560)
        XCTAssertEqual(frame.width, 560)
        XCTAssertEqual(frame.height, 332, "content plus the notch band")
        XCTAssertEqual(frame.maxY, screen.maxY)
        XCTAssertEqual(frame.midX, notch.midX)
    }

    func testExpandedFrameRespectsMaximumAndScreenEdges() {
        let screen = CGRect(x: -1440, y: 0, width: 1440, height: 900)
        let notch = CGRect(x: -1440 + 620, y: 868, width: 200, height: 32)
        let tall = NotchLayout.expandedFrame(notch: notch, screen: screen, contentHeight: 2000, width: 560, maxHeight: 560)
        XCTAssertEqual(tall.height, 560)
        XCTAssertEqual(tall.maxY, screen.maxY)
        XCTAssertTrue(screen.contains(tall))
        let edge = CGRect(x: screen.minX + 40, y: 868, width: 200, height: 32)
        let clamped = NotchLayout.expandedFrame(notch: edge, screen: screen, contentHeight: 100, width: 560, maxHeight: 560)
        XCTAssertEqual(clamped.minX, screen.minX)
        let wide = NotchLayout.expandedFrame(notch: notch, screen: CGRect(x: 0, y: 0, width: 400, height: 900), contentHeight: 100, width: 560, maxHeight: 560)
        XCTAssertEqual(wide.width, 400)
    }

    func testSelectionSkipsNextKeepsSectionOrderAndCountsHiddenRows() {
        let items = [
            item("s1", .scheduled), item("next", .must), item("o1", .overdue), item("m1", .must),
            item("done", .scheduled, status: .done), item("s2", .scheduled), item("s3", .scheduled), item("s4", .scheduled),
        ]
        let selection = NotchLayout.select(items: items, nextId: "next", limit: 5)
        XCTAssertEqual(selection.rows.map(\.id), ["o1", "m1", "s1", "s2", "s3"])
        XCTAssertEqual(selection.hidden, 1)
        XCTAssertEqual(selection.groups.map(\.section), [.overdue, .must, .scheduled])
        XCTAssertEqual(selection.groups.last?.items.map(\.id), ["s1", "s2", "s3"])
        let none = NotchLayout.select(items: items, nextId: nil, limit: 0)
        XCTAssertTrue(none.rows.isEmpty)
        XCTAssertEqual(none.hidden, 7)
    }

    func testCountdownLabels() {
        let now = TCDate.parse("2026-09-07T06:00:00.000Z")!
        XCTAssertNil(NotchLayout.countdown(for: task("a"), now: now))
        XCTAssertEqual(NotchLayout.countdown(for: task("b", scheduledAt: "2026-09-07T06:25:00.000Z"), now: now),
                       NotchLayout.Countdown(text: "还有 25 分钟", late: false))
        XCTAssertEqual(NotchLayout.countdown(for: task("c", scheduledAt: "2026-09-07T08:30:00.000Z"), now: now),
                       NotchLayout.Countdown(text: "还有 2 小时 30 分", late: false))
        XCTAssertEqual(NotchLayout.countdown(for: task("d", scheduledAt: "2026-09-07T05:00:00.000Z"), now: now),
                       NotchLayout.Countdown(text: "已过 1 小时", late: true))
        XCTAssertEqual(NotchLayout.countdown(for: task("e", scheduledAt: "2026-09-07T06:00:20.000Z"), now: now),
                       NotchLayout.Countdown(text: "就是现在", late: false))
        XCTAssertEqual(NotchLayout.countdown(for: task("f", dueAt: "2026-09-07T05:50:00.000Z"), now: now),
                       NotchLayout.Countdown(text: "已逾期 10 分钟", late: true))
        XCTAssertEqual(NotchLayout.countdown(for: task("g", dueAt: "2026-09-09T06:00:00.000Z"), now: now),
                       NotchLayout.Countdown(text: "距截止 2 天", late: false))
        XCTAssertEqual(NotchLayout.countdown(for: task("h", scheduledAt: "2026-09-07T07:00:00.000Z", dueAt: "2026-09-07T05:00:00.000Z"), now: now)?.text,
                       "还有 1 小时", "a planned time wins over the deadline")
    }

    @MainActor func testNotchWindowTakesKeyboardOnlyWhenAllowed() async {
        _ = NSApplication.shared
        let window = NotchWindow(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        XCTAssertTrue(window.styleMask.contains(.nonactivatingPanel))
        XCTAssertFalse(window.canBecomeKey)
        XCTAssertFalse(window.canBecomeMain)
        window.allowsKey = true
        XCTAssertTrue(window.canBecomeKey)
        XCTAssertFalse(window.canBecomeMain)
    }

    @MainActor func testQuickAddFromNotchRequiresConnectionAndText() async {
        let model = AppModel()
        let saved = await model.quickAdd(title: "   ")
        XCTAssertFalse(saved)
        let offline = await model.quickAdd(title: "离线时不能添加")
        XCTAssertFalse(offline, "no runtime connection: nothing is created")
        XCTAssertNil(model.toast, "the field is disabled offline, so no error toast is needed")
        XCTAssertFalse(model.isQuickAdding)
    }
}
