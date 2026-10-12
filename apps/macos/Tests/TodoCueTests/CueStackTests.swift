import XCTest
import AppKit
import TodoCueKit
@testable import TodoCue

/// The pure rules of the stack: what the notch holds, in what order, and when a row changes or leaves.
final class CueStackTests: XCTestCase {
    private let instant = "2026-10-12T04:00:00.000Z"
    private var now: Date { TCDate.parse(instant)! }

    private func taskCue(_ id: String, event: String? = nil, count: Int = 1) -> ReminderCue {
        let task = TodoTask(id: id, title: "任务 \(id)", reminderAt: instant, timezone: "Asia/Shanghai", status: .todo,
                            createdAt: instant, updatedAt: instant)
        return ReminderCue(id: event ?? "r_\(id)", task: task, count: count, late: false, receivedAt: now)
    }

    static func rule(_ id: String, occurrence: String? = nil, round: Int = 1, delivery: String = "displayed",
                     result: String = "pending", state: String = "scheduled", enabled: Bool = true,
                     windows: [[String: String]] = [["start": "00:00", "end": "24:00"]],
                     mode: String = "fixed", at: String = "2026-10-12T04:00:00.000Z") throws -> PeriodicReminder {
        let occurrence = occurrence ?? "po_\(id)_1"
        let occurrenceObject: [String: Any] = ["id": occurrence, "ruleId": id, "ruleVersion": 1, "scheduledAt": at, "fireAt": at,
            "round": round, "delivery": delivery, "result": result, "channel": "notch", "offeredAt": at,
            "claimToken": NSNull(), "claimedAt": NSNull(), "displayedAt": at, "handledAt": NSNull(),
            "lastError": NSNull(), "createdAt": at, "updatedAt": at]
        let object: [String: Any] = ["id": id, "title": "规则 \(id)", "intervalMinutes": 30, "weekdays": Array(1...7),
            "windows": windows, "mode": mode, "timezone": "UTC", "enabled": enabled, "version": 1, "revision": 1,
            "pausedOn": NSNull(), "stateDate": "2026-10-12", "nextFireAt": NSNull(), "currentOccurrenceId": occurrence,
            "currentOccurrence": occurrenceObject, "createdAt": at, "updatedAt": at, "summary": "", "state": state]
        return try JSONDecoder().decode(PeriodicReminder.self, from: JSONSerialization.data(withJSONObject: object))
    }
    private func ruleCue(_ id: String, occurrence: String? = nil, round: Int = 1) throws -> ReminderCue {
        ReminderCue(periodic: try Self.rule(id, occurrence: occurrence, round: round), now: now)
    }

    func testTaskRemindersSitAboveRulesAndArrivalOrderHolds() throws {
        var stack = CueStack()
        XCTAssertEqual(stack.receive(try ruleCue("p_water"), now: now), .added)
        XCTAssertEqual(stack.receive(try ruleCue("p_move"), now: now), .added)
        XCTAssertEqual(stack.receive(taskCue("t_review"), now: now), .added)
        XCTAssertEqual(stack.shown.map(\.key), ["task:t_review", "periodic:p_water", "periodic:p_move"])
        // Answering one row never reorders the others.
        stack.remove("periodic:p_water")
        XCTAssertEqual(stack.shown.map(\.key), ["task:t_review", "periodic:p_move"])
        XCTAssertEqual(stack.receive(try ruleCue("p_eyes"), now: now), .added)
        XCTAssertEqual(stack.shown.map(\.key), ["task:t_review", "periodic:p_move", "periodic:p_eyes"])
    }

    func testTheSameRuleComingRoundAgainIsOneRowWithACount() throws {
        var stack = CueStack()
        stack.receive(try ruleCue("p_water", occurrence: "po_1"), now: now)
        stack.receive(try ruleCue("p_move"), now: now)
        XCTAssertEqual(stack.receive(try ruleCue("p_water", occurrence: "po_2"), now: now.addingTimeInterval(1800)), .merged)
        XCTAssertEqual(stack.receive(try ruleCue("p_water", occurrence: "po_3"), now: now.addingTimeInterval(3600)), .merged)
        XCTAssertEqual(stack.shown.map(\.key), ["periodic:p_water", "periodic:p_move"], "keeps its place")
        XCTAssertEqual(stack.entry("periodic:p_water")?.repeats, 3)
        XCTAssertEqual(stack.entry("periodic:p_water")?.cue.id, "po_3:1")
        XCTAssertEqual(stack.entry("periodic:p_move")?.repeats, 1)
    }

    func testReplayedOrRepeatedEventsDoNotAddOrCount() throws {
        var stack = CueStack()
        let first = taskCue("t_a", event: "r_1")
        XCTAssertEqual(stack.receive(first, now: now), .added)
        XCTAssertEqual(stack.receive(first, now: now), .ignored)
        stack.remove("task:t_a")
        XCTAssertEqual(stack.receive(first, now: now.addingTimeInterval(10)), .ignored, "an answered reminder is not replayed")
        XCTAssertTrue(stack.isEmpty)
        // A snapshot refresh of the same occurrence changes nothing a user would notice.
        stack.receive(try ruleCue("p_a"), now: now)
        XCTAssertEqual(stack.receive(try ruleCue("p_a"), now: now), .ignored)
        XCTAssertEqual(stack.entry("periodic:p_a")?.repeats, 1)
        // Too old to be news.
        let stale = ReminderCue(id: "r_old", task: first.task!, count: 1, late: false, receivedAt: now.addingTimeInterval(-200))
        var fresh = CueStack()
        XCTAssertEqual(fresh.receive(stale, now: now), .ignored)
    }

    func testStackIsBoundedAndShedsRulesBeforeTasks() throws {
        var stack = CueStack()
        stack.receive(taskCue("t_keep"), now: now)
        for index in 0..<30 { stack.receive(try ruleCue("p_\(index)"), now: now) }
        XCTAssertEqual(stack.entries.count, CueStack.capacity)
        XCTAssertNotNil(stack.entry("task:t_keep"))
        XCTAssertNil(stack.entry("periodic:p_0"), "the oldest rule went first")
        stack.clear()
        XCTAssertTrue(stack.isEmpty)
    }

    func testARuleOutsideItsWindowStepsBackAndLandsAgainWithOneMore() throws {
        var stack = CueStack()
        stack.receive(try ruleCue("p_water"), now: now)
        XCTAssertTrue(stack.setDormant("periodic:p_water", true, now: now))
        XCTAssertTrue(stack.isEmpty)
        XCTAssertNotNil(stack.entry("periodic:p_water"), "the row is kept, only hidden")
        XCTAssertFalse(stack.setDormant("periodic:p_water", true, now: now), "no change, nothing to publish")
        let back = now.addingTimeInterval(3600)
        XCTAssertTrue(stack.setDormant("periodic:p_water", false, now: back))
        XCTAssertEqual(stack.shown.map(\.key), ["periodic:p_water"])
        XCTAssertEqual(stack.entry("periodic:p_water")?.repeats, 2)
        XCTAssertEqual(stack.entry("periodic:p_water")?.arrivedAt, back)
    }

    func testCueKeysIdentifyTheSourceNotTheOccurrence() throws {
        XCTAssertEqual(taskCue("t_a", event: "r_1").key, taskCue("t_a", event: "r_2").key)
        XCTAssertNotEqual(taskCue("t_a").key, taskCue("t_b").key)
        XCTAssertEqual(try ruleCue("p_a", occurrence: "po_1").key, try ruleCue("p_a", occurrence: "po_2", round: 2).key)
    }

    @MainActor func testOnlyAnOpenOccurrenceHoldsARow() throws {
        XCTAssertTrue(NotchController.holdsPending(try Self.rule("p_a", delivery: "displayed")))
        XCTAssertTrue(NotchController.holdsPending(try Self.rule("p_a", delivery: "offered")), "next slot, claim still in flight")
        XCTAssertTrue(NotchController.holdsPending(try Self.rule("p_a", delivery: "submitted")), "went to the system instead")
        XCTAssertFalse(NotchController.holdsPending(try Self.rule("p_a", delivery: "scheduled")), "snoozed until later")
        XCTAssertFalse(NotchController.holdsPending(try Self.rule("p_a", result: "completed")))
        XCTAssertFalse(NotchController.holdsPending(try Self.rule("p_a", result: "expired")))
        XCTAssertFalse(NotchController.holdsPending(try Self.rule("p_a", state: "paused_today")))
        XCTAssertFalse(NotchController.holdsPending(try Self.rule("p_a", state: "paused")))
        XCTAssertFalse(NotchController.holdsPending(try Self.rule("p_a", enabled: false)))
    }
}
