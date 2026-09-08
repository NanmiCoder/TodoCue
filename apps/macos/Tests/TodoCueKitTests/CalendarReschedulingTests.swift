import XCTest
@testable import TodoCueKit

/// Dragging a task onto a day changes the plan and nothing else.
final class CalendarReschedulingTests: XCTestCase {
    private var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        return c
    }

    private func task(scheduledDate: String? = nil, scheduledAt: String? = nil,
                      dueDate: String? = nil, dueAt: String? = nil, reminderAt: String? = nil) -> TodoTask {
        TodoTask(id: "t1", title: "写周报", scheduledDate: scheduledDate, scheduledAt: scheduledAt,
                 dueDate: dueDate, dueAt: dueAt, reminderAt: reminderAt, timezone: "Asia/Shanghai",
                 createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z")
    }

    func testADateLevelPlanStaysDateLevel() {
        let payload = TaskRescheduling.plan(task(scheduledDate: "2026-09-08"), on: "2026-09-11")
        XCTAssertEqual(payload.fields["scheduledDate"], .string("2026-09-11"))
        XCTAssertEqual(payload.fields["scheduledAt"], .null)
    }

    func testATimedPlanKeepsItsTimeOfDay() {
        // 2026-09-08T01:30Z is 09:30 in Shanghai; the same wall-clock time must survive the move.
        let payload = TaskRescheduling.plan(task(scheduledAt: "2026-09-08T01:30:00.000Z"),
                                            on: "2026-09-11")
        XCTAssertEqual(payload.fields["scheduledAt"], .string("2026-09-11T01:30:00.000Z"))
        XCTAssertEqual(payload.fields["scheduledDate"], .null)
    }

    func testTheDeadlineAndReminderAreNeverTouched() {
        // This is the whole difference from `tomorrow`, which drags an overdue deadline along.
        let payload = TaskRescheduling.plan(task(scheduledDate: "2026-09-08", dueDate: "2026-09-20",
                                                 reminderAt: "2026-09-08T01:00:00.000Z"),
                                            on: "2026-09-11")
        XCTAssertNil(payload.fields["dueDate"])
        XCTAssertNil(payload.fields["dueAt"])
        XCTAssertNil(payload.fields["reminderAt"])
        XCTAssertEqual(payload.fields.count, 2)
    }

    func testMovingBackwardsOntoTodayOrThePastIsExpressible() {
        // The runtime's `moveTask` refuses any target on or before today; the calendar must not,
        // or "drag the overdue one onto today" would be impossible.
        let payload = TaskRescheduling.plan(task(scheduledDate: "2026-09-20"), on: "2026-09-01")
        XCTAssertEqual(payload.fields["scheduledDate"], .string("2026-09-01"))
    }

    func testTheTimeOfDayIsReadInTheTasksOwnZoneNotTheViewers() {
        // planDate — which decides the cell the task is drawn in — resolves in the task's zone.
        // Doing the arithmetic in the viewer's zone instead lands it a day off.
        let newYork = TodoTask(id: "t1", title: "写周报", scheduledAt: "2026-09-08T22:00:00.000Z",
                               timezone: "America/New_York",
                               createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z")
        XCTAssertEqual(newYork.planDate, "2026-09-08", "18:00 in New York")
        let payload = TaskRescheduling.plan(newYork, on: "2026-09-11")
        // 18:00 New York on the 11th is 22:00Z on the 11th, not the 10th.
        XCTAssertEqual(payload.fields["scheduledAt"], .string("2026-09-11T22:00:00.000Z"))

        var moved = newYork
        moved.scheduledAt = "2026-09-11T22:00:00.000Z"
        XCTAssertEqual(moved.planDate, "2026-09-11", "it must land on the day it was dropped on")
    }

    func testADayLevelPlanIsUnaffectedByZone() {
        let task = TodoTask(id: "t1", title: "写周报", scheduledDate: "2026-09-08",
                            timezone: "Pacific/Kiritimati",
                            createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z")
        XCTAssertEqual(TaskRescheduling.plan(task, on: "2026-09-11").fields["scheduledDate"], .string("2026-09-11"))
    }

    func testLandsAfterDeadlineCoversTheSameDayTimeCase() {
        // The runtime's condition is `date > dueDate || (scheduledAt && dueAt && scheduledAt > dueAt)`.
        // Dropping an 18:00 task onto the day of a 10:00 deadline needs the confirmation too.
        let evening = TodoTask(id: "t1", title: "写周报", scheduledAt: "2026-09-08T10:00:00.000Z",
                               dueAt: "2026-09-20T02:00:00.000Z", timezone: "Asia/Shanghai",
                               createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z")
        XCTAssertEqual(TCDate.dateString(TCDate.parse(evening.dueAt!)!, timezone: "Asia/Shanghai"), "2026-09-20")
        // 18:00 Shanghai on the deadline's own day is after the 10:00 deadline.
        XCTAssertTrue(TaskRescheduling.landsAfterDeadline(evening, on: "2026-09-20"))
        XCTAssertFalse(TaskRescheduling.landsAfterDeadline(evening, on: "2026-09-19"))
    }

    func testLandsAfterDeadlineMatchesTheRuntimeCondition() {
        XCTAssertFalse(TaskRescheduling.landsAfterDeadline(task(dueDate: "2026-09-20"), on: "2026-09-19"))
        XCTAssertFalse(TaskRescheduling.landsAfterDeadline(task(dueDate: "2026-09-20"), on: "2026-09-20"))
        XCTAssertTrue(TaskRescheduling.landsAfterDeadline(task(dueDate: "2026-09-20"), on: "2026-09-21"))
        // A deadline held as an instant resolves in the task's own timezone.
        XCTAssertTrue(TaskRescheduling.landsAfterDeadline(task(dueAt: "2026-09-20T10:00:00.000Z"), on: "2026-09-21"))
        XCTAssertFalse(TaskRescheduling.landsAfterDeadline(task(), on: "2027-01-01"))
    }
}
