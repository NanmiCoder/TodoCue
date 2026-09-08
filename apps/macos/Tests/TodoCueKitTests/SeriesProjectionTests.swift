import XCTest
@testable import TodoCueKit

final class SeriesProjectionTests: XCTestCase {
    private func series(_ id: String = "s1", rule: RecurrenceRule = .daily, startDate: String = "2026-09-01",
                        endDate: String? = nil, status: SeriesStatus = .active,
                        generatedThrough: String? = nil) -> Series {
        Series(id: id, title: "每日站会", notes: nil, project: "work", priority: .medium, estimateMinutes: nil,
               rule: rule, scheduledTime: "09:00", reminderTime: nil, timezone: "Asia/Shanghai",
               startDate: startDate, endDate: endDate, status: status, stoppedAt: nil,
               generatedThrough: generatedThrough, version: 1,
               createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z")
    }

    func testDailyGhostsCoverEveryDayAfterTheGeneratedHorizon() {
        let ghosts = SeriesProjection.occurrences([series(generatedThrough: "2026-10-08")],
                                                  from: "2026-10-01", to: "2026-10-12", existing: [])
        XCTAssertEqual(ghosts.map(\.date), ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"])
        XCTAssertEqual(ghosts.first?.title, "每日站会")
        XCTAssertEqual(ghosts.first?.scheduledTime, "09:00")
        XCTAssertEqual(ghosts.first?.project, "work")
        XCTAssertEqual(ghosts.first?.id, "s1@2026-10-09")
    }

    func testWeeklyGhostsLandOnlyOnTheRuleWeekdays() {
        // 2027-03-01 is a Monday.
        let ghosts = SeriesProjection.occurrences([series(rule: .weekly(weekdays: [1, 3, 5]),
                                                          generatedThrough: "2027-02-28")],
                                                  from: "2027-03-01", to: "2027-03-14", existing: [])
        XCTAssertEqual(ghosts.map(\.date), ["2027-03-01", "2027-03-03", "2027-03-05",
                                            "2027-03-08", "2027-03-10", "2027-03-12"])
        XCTAssertTrue(ghosts.allSatisfy { [1, 3, 5].contains(CivilDate.isoWeekday($0.date)) })
    }

    func testWeeklyRuleUsesISOWeekdaysSoSundayIsSeven() {
        let sundays = SeriesProjection.occurrences([series(rule: .weekly(weekdays: [7]), generatedThrough: "2026-08-31")],
                                                   from: "2026-09-01", to: "2026-09-14", existing: [])
        XCTAssertEqual(sundays.map(\.date), ["2026-09-06", "2026-09-13"])
    }

    func testEndDateAndStartDateBoundTheProjection() {
        let bounded = SeriesProjection.occurrences([series(startDate: "2026-10-10", endDate: "2026-10-12",
                                                           generatedThrough: nil)],
                                                   from: "2026-10-01", to: "2026-10-20", existing: [])
        XCTAssertEqual(bounded.map(\.date), ["2026-10-10", "2026-10-11", "2026-10-12"])
    }

    func testStoppedSeriesProducesNothing() {
        let stopped = SeriesProjection.occurrences([series(status: .stopped, generatedThrough: "2026-09-01")],
                                                   from: "2026-10-01", to: "2026-10-05", existing: [])
        XCTAssertTrue(stopped.isEmpty)
    }

    func testNothingIsProjectedInsideTheGeneratedHorizon() {
        // The client snapshot only holds todo tasks, so a completed or skipped instance inside the
        // horizon has no row. Cutting off at `generatedThrough` — rather than at "no row exists" —
        // is what stops it being resurrected as a ghost.
        let ghosts = SeriesProjection.occurrences([series(generatedThrough: "2026-10-01")],
                                                  from: "2026-09-20", to: "2026-10-01", existing: [])
        XCTAssertTrue(ghosts.isEmpty)
    }

    func testExistingInstancesAreSkippedWhenGeneratedThroughLagsBehind() {
        // `refreshLive` never refetches series while the scheduler tops instances up every 5s.
        let ghosts = SeriesProjection.occurrences([series(generatedThrough: "2026-10-01")],
                                                  from: "2026-10-01", to: "2026-10-04",
                                                  existing: ["s1@2026-10-02", "s1@2026-10-03"])
        XCTAssertEqual(ghosts.map(\.date), ["2026-10-04"])
    }

    func testInvertedRangeAndMissingHorizonAreHandled() {
        XCTAssertTrue(SeriesProjection.occurrences([series()], from: "2026-10-05", to: "2026-10-01", existing: []).isEmpty)
        // No `generatedThrough` at all means nothing has been created, so the start date is the floor.
        let fresh = SeriesProjection.occurrences([series(startDate: "2026-10-02", generatedThrough: nil)],
                                                 from: "2026-10-01", to: "2026-10-03", existing: [])
        XCTAssertEqual(fresh.map(\.date), ["2026-10-02", "2026-10-03"])
    }

    func testAMalformedButStorableDateSkipsTheSeriesInsteadOfHangingTheMainActor() {
        // `DateString` in packages/shared is regex-only and `createSeries` never calls `assertDate`,
        // so a CLI or MCP client can store 2026-02-30. A string cursor advanced by `CivilDate.adding`
        // would sit on it forever while `cursor <= end` stayed true.
        let cases = [series(startDate: "2026-02-30"),
                     series(generatedThrough: "2026-13-01"),
                     series(endDate: "2026-11-31", generatedThrough: "2026-10-01")]
        for bad in cases {
            let ghosts = SeriesProjection.occurrences([bad], from: "2026-10-01", to: "2026-10-05", existing: [])
            XCTAssertTrue(ghosts.isEmpty, bad.startDate + "/" + (bad.generatedThrough ?? "nil"))
        }
        // A healthy series alongside a broken one still projects.
        let mixed = SeriesProjection.occurrences([series(startDate: "2026-02-30"),
                                                  series("s2", generatedThrough: "2026-09-30")],
                                                 from: "2026-10-01", to: "2026-10-03", existing: [])
        XCTAssertEqual(mixed.map(\.seriesId), ["s2", "s2", "s2"])
    }

    func testMatchesRuleMirrorsTheRuntime() {
        XCTAssertTrue(SeriesProjection.matches(.daily, "2026-09-06"))
        XCTAssertTrue(SeriesProjection.matches(.weekly(weekdays: [1]), "2026-09-07"))
        XCTAssertFalse(SeriesProjection.matches(.weekly(weekdays: [1]), "2026-09-08"))
    }
}
