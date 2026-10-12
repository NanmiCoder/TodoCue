import XCTest
@testable import TodoCueKit

/// `isActive` must agree with the runtime's `periodicIsActive`: ISO weekdays with Monday as 1, windows
/// half-open at the end, all read in the rule's own timezone.
final class PeriodicActivityTests: XCTestCase {
    private func rule(weekdays: [Int] = Array(1...7), windows: [[String: String]] = [["start": "09:00", "end": "18:00"]],
                      timezone: String = "Asia/Shanghai", enabled: Bool = true, fireAt: String? = nil) throws -> PeriodicReminder {
        var object: [String: Any] = ["id": "p_a", "title": "喝水", "intervalMinutes": 30, "weekdays": weekdays,
            "windows": windows, "mode": "fixed", "timezone": timezone, "enabled": enabled, "version": 1,
            "stateDate": "2026-10-12", "nextFireAt": NSNull(), "currentOccurrenceId": NSNull(), "currentOccurrence": NSNull(),
            "createdAt": "2026-10-12T00:00:00Z", "updatedAt": "2026-10-12T00:00:00Z", "summary": "", "state": "scheduled"]
        if let fireAt {
            object["currentOccurrenceId"] = "po_1"
            object["currentOccurrence"] = ["id": "po_1", "ruleId": "p_a", "ruleVersion": 1, "scheduledAt": fireAt, "fireAt": fireAt,
                "round": 1, "delivery": "displayed", "result": "pending", "channel": "notch", "offeredAt": fireAt,
                "claimToken": NSNull(), "claimedAt": NSNull(), "displayedAt": fireAt, "handledAt": NSNull(),
                "lastError": NSNull(), "createdAt": fireAt, "updatedAt": fireAt]
        }
        return try JSONDecoder().decode(PeriodicReminder.self, from: JSONSerialization.data(withJSONObject: object))
    }
    private func at(_ iso: String) -> Date { TCDate.parse(iso)! }

    func testWindowsAreHalfOpenInTheRulesOwnTimezone() throws {
        let r = try rule()
        // 2026-10-12 is a Monday; Shanghai is UTC+8.
        XCTAssertFalse(r.isActive(at: at("2026-10-12T00:59:00Z")), "08:59 local")
        XCTAssertTrue(r.isActive(at: at("2026-10-12T01:00:00Z")), "09:00 local, start is inclusive")
        XCTAssertTrue(r.isActive(at: at("2026-10-12T09:59:00Z")), "17:59 local")
        XCTAssertFalse(r.isActive(at: at("2026-10-12T10:00:00Z")), "18:00 local, end is exclusive")
    }

    func testWeekdaysUseMondayAsOneAndSundayAsSeven() throws {
        let weekdaysOnly = try rule(weekdays: [1, 2, 3, 4, 5])
        XCTAssertTrue(weekdaysOnly.isActive(at: at("2026-10-12T04:00:00Z")), "Monday noon")
        XCTAssertFalse(weekdaysOnly.isActive(at: at("2026-10-10T04:00:00Z")), "Saturday noon")
        XCTAssertFalse(weekdaysOnly.isActive(at: at("2026-10-11T04:00:00Z")), "Sunday noon")
        let sundayOnly = try rule(weekdays: [7])
        XCTAssertTrue(sundayOnly.isActive(at: at("2026-10-11T04:00:00Z")))
        XCTAssertFalse(sundayOnly.isActive(at: at("2026-10-12T04:00:00Z")))
    }

    func testBreaksBetweenWindowsAndAllDayEnd() throws {
        let split = try rule(windows: [["start": "09:00", "end": "12:00"], ["start": "13:00", "end": "18:00"]])
        XCTAssertTrue(split.isActive(at: at("2026-10-12T03:59:00Z")), "11:59")
        XCTAssertFalse(split.isActive(at: at("2026-10-12T04:30:00Z")), "12:30 lunch")
        XCTAssertTrue(split.isActive(at: at("2026-10-12T05:00:00Z")), "13:00")
        let allDay = try rule(windows: [["start": "00:00", "end": "24:00"]])
        XCTAssertTrue(allDay.isActive(at: at("2026-10-12T15:59:00Z")), "23:59 local")
    }

    func testOtherTimezoneAndDisabledRule() throws {
        let newYork = try rule(timezone: "America/New_York")
        // 13:00Z is 09:00 EDT, 12:59Z is 08:59 EDT.
        XCTAssertTrue(newYork.isActive(at: at("2026-10-12T13:00:00Z")))
        XCTAssertFalse(newYork.isActive(at: at("2026-10-12T12:59:00Z")))
        XCTAssertFalse(try rule(enabled: false).isActive(at: at("2026-10-12T04:00:00Z")))
        XCTAssertFalse(try rule(timezone: "Nowhere/Invalid").isActive(at: at("2026-10-12T04:00:00Z")))
    }

    func testWaitingMinutesCountFromTheOpenOccurrence() throws {
        let waiting = try rule(fireAt: "2026-10-12T04:00:00Z")
        XCTAssertEqual(waiting.waitingMinutes(now: at("2026-10-12T04:12:30Z")), 12)
        XCTAssertEqual(waiting.waitingMinutes(now: at("2026-10-12T03:59:00Z")), 0, "never negative")
        XCTAssertNil(try rule().waitingMinutes(now: at("2026-10-12T04:12:30Z")))
    }
}
