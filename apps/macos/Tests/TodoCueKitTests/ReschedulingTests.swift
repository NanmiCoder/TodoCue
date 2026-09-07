import XCTest
@testable import TodoCueKit

final class ReschedulingTests: XCTestCase {
    private var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        return c
    }
    private let now = TCDate.parse("2026-09-07T03:00:00Z")!
    private func task() -> TodoTask {
        TodoTask(id: "test", title: "测试任务", timezone: "Asia/Shanghai", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z")
    }

    func testSeveralDaysOverdueMovesToActualTomorrowWithTimePreserved() {
        var t = task()
        t.scheduledAt = "2026-09-02T01:30:00Z"
        t.dueAt = "2026-09-02T10:00:00Z"
        let p = TaskRescheduling.tomorrow(t, now: now, calendar: calendar)
        XCTAssertEqual(p.fields["scheduledAt"], .string("2026-09-08T01:30:00.000Z"))
        XCTAssertEqual(p.fields["dueAt"], .string("2026-09-08T10:00:00.000Z"))
        XCTAssertEqual(p.fields["scheduledDate"], .null)
        XCTAssertNil(p.fields["reminderAt"])
    }

    func testDeadlineTodayMovesOutOfTodayIncludingAnUpcomingTime() {
        var t = task()
        t.dueAt = "2026-09-07T12:00:00Z"
        let p = TaskRescheduling.tomorrow(t, now: now, calendar: calendar)
        XCTAssertEqual(p.fields["dueAt"], .string("2026-09-08T12:00:00.000Z"))
        XCTAssertEqual(p.fields["scheduledDate"], .string("2026-09-08"))
    }

    func testDatePrecisionAndFutureDeadlineArePreserved() {
        var t = task()
        t.dueDate = "2026-09-07"
        let p = TaskRescheduling.tomorrow(t, now: now, calendar: calendar)
        XCTAssertEqual(p.fields["dueDate"], .string("2026-09-08"))
        t.dueDate = "2026-09-12"
        XCTAssertNil(TaskRescheduling.tomorrow(t, now: now, calendar: calendar).fields["dueDate"])
    }

    func testUnscheduledTaskAndMonthBoundary() {
        let p = TaskRescheduling.tomorrow(task(), now: TCDate.parse("2026-09-30T10:00:00Z")!, calendar: calendar)
        XCTAssertEqual(p.fields["scheduledDate"], .string("2026-10-01"))
    }
}
