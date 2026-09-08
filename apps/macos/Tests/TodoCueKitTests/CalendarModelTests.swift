import XCTest
@testable import TodoCueKit

final class CivilDateTests: XCTestCase {
    func testEpochDayRoundTripsAcrossCenturyAndLeapBoundaries() {
        for date in ["1970-01-01", "1969-12-31", "1900-03-01", "2000-02-29", "2026-09-07", "2100-02-28", "2400-12-31"] {
            XCTAssertEqual(CivilDate.date(epochDay: CivilDate.epochDay(date)!), date, date)
        }
        XCTAssertEqual(CivilDate.epochDay("1970-01-01"), 0)
        XCTAssertNil(CivilDate.epochDay("2026-02-30"))
        XCTAssertNil(CivilDate.epochDay("2026-9-7"))
    }

    func testISOWeekdayIsMondayFirstAndIndependentOfTheSystemCalendar() {
        XCTAssertEqual(CivilDate.isoWeekday("2026-09-07"), 1) // Monday
        XCTAssertEqual(CivilDate.isoWeekday("2026-09-06"), 7) // Sunday — where a 1=Sunday calendar would disagree
        XCTAssertEqual(CivilDate.isoWeekday("1969-12-31"), 3) // Wednesday, before the epoch

        // `RecurrenceRule.weekly` weekdays are ISO (1=Mon). Foundation's `.weekday` is 1=Sun, and
        // its numbering does not move with `firstWeekday` — reading it would be off by one exactly
        // on Sundays, so pin that CivilDate disagrees with Foundation in the way we expect.
        let sunday = TCDate.parseLocalDate("2026-09-06")!
        for first in 1...7 {
            var calendar = Calendar(identifier: .gregorian)
            calendar.firstWeekday = first
            XCTAssertEqual(calendar.component(.weekday, from: sunday), 1, "firstWeekday=\(first)")
            XCTAssertEqual(CivilDate.isoWeekday("2026-09-06"), 7, "firstWeekday=\(first)")
        }
    }

    func testMalformedButRegexValidDatesAreRejectedRatherThanLoopingForever() {
        // The runtime validates YYYY-MM-DD by regex only, so these are storable via CLI or MCP.
        for bad in ["2026-02-30", "2026-13-01", "2026-00-10", "2026-09-31"] {
            XCTAssertNil(CivilDate.epochDay(bad), bad)
            XCTAssertNil(CivilDate.parse(bad), bad)
            // `adding` returns its input for these, which is why no loop may use it as a cursor.
            XCTAssertEqual(CivilDate.adding(1, to: bad), bad, bad)
        }
    }

    func testDayIterationIsIdenticalInEveryTimeZoneIncludingAcrossDSTTransitions() {
        let original = NSTimeZone.default
        defer { NSTimeZone.default = original }
        // Spring forward (2026-03-08) and fall back (2026-11-01) sit inside these windows;
        // Pacific/Chatham is a 45-minute offset, Asia/Kolkata a 30-minute one.
        let expected = ["2026-03-06": ["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"],
                        "2026-10-30": ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]]
        for zone in ["America/New_York", "UTC", "Asia/Kolkata", "Pacific/Chatham", "Australia/Lord_Howe"] {
            NSTimeZone.default = TimeZone(identifier: zone)!
            for (start, days) in expected {
                XCTAssertEqual((0..<5).map { CivilDate.adding($0, to: start) }, days, "\(zone) \(start)")
            }
        }
    }

    func testAddingMonthsClampsTheDayAndNeverDrifts() {
        var cursor = "2026-01-31"
        cursor = CivilDate.addingMonths(1, to: cursor)
        XCTAssertEqual(cursor, "2026-02-28")
        // Stepping on from the clamped value must not silently walk backwards through the year.
        XCTAssertEqual(CivilDate.addingMonths(1, to: cursor), "2026-03-28")
        XCTAssertEqual(CivilDate.addingMonths(12, to: "2024-02-29"), "2025-02-28")
        XCTAssertEqual(CivilDate.addingMonths(-1, to: "2026-01-15"), "2025-12-15")
        XCTAssertEqual(CivilDate.addingMonths(-13, to: "2026-01-15"), "2024-12-15")
    }
}

final class CalendarRangeTests: XCTestCase {
    private let monday = 2
    private let sunday = 1

    func testFirstWeekdayFollowsTheAppLanguageNotTheLocaleData() {
        // Foundation reports firstWeekday == 1 even for zh-Hans-CN, which contradicts both the
        // convention and this app's own Monday-first weekday picker.
        XCTAssertEqual(CalendarRange.firstWeekday(.chinese), 2)
        XCTAssertEqual(CalendarRange.firstWeekday(.english), 1)
    }

    func testMonthGridIsWholeWeeksStartingOnTheChosenFirstWeekday() {
        // 2026-09-01 is a Tuesday.
        let mondayFirst = CalendarRange.days(span: .month, anchor: "2026-09-15", firstWeekday: monday)
        XCTAssertEqual(mondayFirst.first, "2026-08-31")
        XCTAssertEqual(mondayFirst.count, 35)
        XCTAssertEqual(mondayFirst.last, "2026-10-04")

        let sundayFirst = CalendarRange.days(span: .month, anchor: "2026-09-15", firstWeekday: sunday)
        XCTAssertEqual(sundayFirst.first, "2026-08-30")
        XCTAssertEqual(sundayFirst.count, 35)

        for anchor in ["2026-01-15", "2026-02-15", "2026-12-15", "2027-01-15", "2024-02-15"] {
            for first in [sunday, monday] {
                let days = CalendarRange.days(span: .month, anchor: anchor, firstWeekday: first)
                XCTAssertEqual(days.count % 7, 0, anchor)
                XCTAssertTrue([28, 35, 42].contains(days.count), "\(anchor) \(days.count)")
                XCTAssertTrue(days.contains(CivilDate.firstOfMonth(anchor)), anchor)
                XCTAssertTrue(days.contains(CivilDate.lastOfMonth(anchor)), anchor)
                XCTAssertEqual(Set(days).count, days.count, anchor)
            }
        }
    }

    func testWeekSpanIsSevenDaysContainingTheAnchor() {
        let week = CalendarRange.days(span: .week, anchor: "2026-09-06", firstWeekday: monday)
        XCTAssertEqual(week, ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03",
                              "2026-09-04", "2026-09-05", "2026-09-06"])
        XCTAssertEqual(CalendarRange.days(span: .week, anchor: "2026-09-06", firstWeekday: sunday).first, "2026-09-06")
    }

    func testWeekRowsMatchesTheGridAndFeedsTheHeightLadder() {
        XCTAssertEqual(CalendarRange.weekRows(span: .month, anchor: "2026-09-15", firstWeekday: monday), 5)
        // February 2026 starts on a Sunday and has 28 days: exactly four rows when weeks start Sunday.
        XCTAssertEqual(CalendarRange.weekRows(span: .month, anchor: "2026-02-10", firstWeekday: sunday), 4)
        XCTAssertEqual(CalendarRange.weekRows(span: .month, anchor: "2026-08-15", firstWeekday: monday), 6)
        XCTAssertEqual(CalendarRange.weekRows(span: .week, anchor: "2026-09-15", firstWeekday: monday), 1)
    }

    func testShiftCrossesMonthAndYearBoundaries() {
        XCTAssertEqual(CalendarRange.shift(span: .month, anchor: "2026-12-15", by: 1), "2027-01-15")
        XCTAssertEqual(CalendarRange.shift(span: .month, anchor: "2026-01-15", by: -1), "2025-12-15")
        XCTAssertEqual(CalendarRange.shift(span: .week, anchor: "2026-12-30", by: 1), "2027-01-06")
        XCTAssertEqual(CalendarRange.shift(span: .week, anchor: "2027-01-01", by: -1), "2026-12-25")
    }

    func testContainsDistinguishesPaddingDaysFromTheAnchoredSpan() {
        XCTAssertTrue(CalendarRange.contains(span: .month, anchor: "2026-09-15", date: "2026-09-01", firstWeekday: monday))
        XCTAssertFalse(CalendarRange.contains(span: .month, anchor: "2026-09-15", date: "2026-08-31", firstWeekday: monday))
        XCTAssertTrue(CalendarRange.contains(span: .week, anchor: "2026-09-01", date: "2026-08-31", firstWeekday: monday))
        XCTAssertFalse(CalendarRange.contains(span: .week, anchor: "2026-09-01", date: "2026-08-30", firstWeekday: monday))
    }

    func testWeekdaySymbolsRotateAndStayNarrowEnoughForA35ptColumn() {
        let chinese = CalendarRange.weekdaySymbols(firstWeekday: monday, language: .chinese)
        XCTAssertEqual(chinese, ["一", "二", "三", "四", "五", "六", "日"])
        let english = CalendarRange.weekdaySymbols(firstWeekday: sunday, language: .english)
        XCTAssertEqual(english.count, 7)
        XCTAssertEqual(english.first, "Su")
        XCTAssertEqual(english[1], "Mo")
        // "S M T W T F S" would be ambiguous, three letters would not fit — two is the compromise.
        XCTAssertTrue(english.allSatisfy { $0.count == 2 }, "\(english)")
    }

    func testDatesOutsideTheCurrentYearCarryTheirYear() {
        let today = "2026-09-08"
        // Near today the relative wording is unambiguous and shorter.
        XCTAssertEqual(CalendarRange.dayLabel("2026-09-08", language: .english, today: today), "Today")
        XCTAssertEqual(CalendarRange.dayLabel("2026-09-09", language: .english, today: today), "Tomorrow")
        XCTAssertEqual(CalendarRange.dayLabel("2026-09-07", language: .english, today: today), "Yesterday")
        // Same year: no year needed. Another year: it must be there, or paging to March 2027
        // produces a heading identical to March 2026.
        XCTAssertFalse(CalendarRange.dayLabel("2026-03-04", language: .english, today: today).contains("2026"))
        XCTAssertTrue(CalendarRange.dayLabel("2027-03-04", language: .english, today: today).contains("2027"))
        XCTAssertTrue(CalendarRange.dayLabel("2027-03-04", language: .chinese, today: today).contains("2027"))
        // The week title is the only year cue in the week span.
        XCTAssertTrue(CalendarRange.title(span: .week, anchor: "2027-03-04", firstWeekday: 2,
                                          language: .english, today: today).contains("2027"))
        XCTAssertFalse(CalendarRange.title(span: .week, anchor: "2026-09-09", firstWeekday: 2,
                                           language: .english, today: today).contains("2026"))
    }

    func testFirstWeekdayDefersToTheRegionForEnglishButNotForChinese() {
        XCTAssertEqual(CalendarRange.firstWeekday(.chinese, region: 1), 2)
        XCTAssertEqual(CalendarRange.firstWeekday(.english, region: 1), 1)  // en-US
        XCTAssertEqual(CalendarRange.firstWeekday(.english, region: 2), 2)  // en-GB, en-AU
    }

    func testTitlesStayShortEnoughForTheNavigatorAndCarryNoCatalogEntry() {
        let english = CalendarRange.title(span: .month, anchor: "2026-09-15", firstWeekday: sunday, language: .english, today: "2026-09-08")
        XCTAssertTrue(english.contains("2026"), english)
        XCTAssertFalse(english.contains("September"), "yMMMM does not fit the 300pt navigator: \(english)")
        let chinese = CalendarRange.title(span: .month, anchor: "2026-09-15", firstWeekday: monday, language: .chinese, today: "2026-09-08")
        XCTAssertTrue(chinese.contains("2026"), chinese)
        XCTAssertTrue(CalendarRange.title(span: .week, anchor: "2026-09-09", firstWeekday: monday,
                                          language: .english, today: "2026-09-08").contains("–"))
    }
}

final class CalendarBucketsTests: XCTestCase {
    private func task(_ id: String, scheduledDate: String? = nil, scheduledAt: String? = nil,
                      dueDate: String? = nil, dueAt: String? = nil, status: TaskStatus = .todo,
                      seriesId: String? = nil, occurrenceDate: String? = nil) -> TodoTask {
        TodoTask(id: id, title: "任务 \(id)", scheduledDate: scheduledDate, scheduledAt: scheduledAt,
                 dueDate: dueDate, dueAt: dueAt, timezone: "Asia/Shanghai", status: status,
                 seriesId: seriesId, occurrenceDate: occurrenceDate,
                 createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z")
    }

    func testTaskSitsOnItsPlanDateAndItsDeadlineIsMarkedSeparately() {
        let planned = task("a", scheduledDate: "2026-09-10", dueDate: "2026-09-14")
        let buckets = CalendarBuckets.build(todo: [planned], history: [], series: [],
                                            from: "2026-09-01", to: "2026-09-30")
        XCTAssertEqual(buckets["2026-09-10"]?.planned.map(\.id), ["a"])
        XCTAssertEqual(buckets["2026-09-14"]?.deadlines.map(\.id), ["a"])
        XCTAssertTrue(buckets["2026-09-14"]?.planned.isEmpty ?? true)
        XCTAssertNil(buckets["2026-09-11"])
    }

    func testDueOnlyTaskIsPlannedOnceAndNotAlsoMarkedAsADeadline() {
        // planDate falls back to the due date, so the deadline marker must not duplicate it.
        let buckets = CalendarBuckets.build(todo: [task("a", dueDate: "2026-09-14")], history: [], series: [],
                                            from: "2026-09-01", to: "2026-09-30")
        XCTAssertEqual(buckets["2026-09-14"]?.planned.map(\.id), ["a"])
        XCTAssertTrue(buckets["2026-09-14"]?.deadlines.isEmpty ?? true)
        XCTAssertEqual(buckets["2026-09-14"]?.openCount, 1)
    }

    func testUnscheduledTasksAreDroppedRatherThanBucketedUnderAnEmptyKey() {
        let buckets = CalendarBuckets.build(todo: [task("a")], history: [], series: [],
                                            from: "2026-09-01", to: "2026-09-30")
        XCTAssertTrue(buckets.isEmpty)
        XCTAssertNil(buckets[""])
    }

    func testCompletedTasksLandInHistoryAndOutOfTheOpenCount() {
        let buckets = CalendarBuckets.build(todo: [], history: [task("a", scheduledDate: "2026-09-02", status: .done),
                                                                task("b", scheduledDate: "2026-09-02", status: .cancelled)],
                                            series: [], from: "2026-09-01", to: "2026-09-30")
        XCTAssertEqual(buckets["2026-09-02"]?.history.count, 2)
        XCTAssertEqual(buckets["2026-09-02"]?.openCount, 0)
        XCTAssertFalse(buckets["2026-09-02"]?.isEmpty ?? true)
    }

    func testAReopenedTaskDoesNotAlsoShowFromAStaleHistoryPage() {
        // The board says todo; a previously fetched history window still holds the done copy.
        let reopened = task("a", scheduledDate: "2026-09-02")
        let stale = task("a", scheduledDate: "2026-09-02", status: .done)
        let buckets = CalendarBuckets.build(todo: [reopened], history: [stale], series: [],
                                            from: "2026-09-01", to: "2026-09-30")
        XCTAssertEqual(buckets["2026-09-02"]?.planned.map(\.id), ["a"])
        XCTAssertTrue(buckets["2026-09-02"]?.history.isEmpty ?? true)
        XCTAssertEqual(buckets["2026-09-02"]?.openCount, 1)
    }

    func testAFinishedTaskNoLongerMarksItsDeadlineDayAsOutstanding() {
        let done = task("a", scheduledDate: "2026-09-10", dueDate: "2026-09-14", status: .done)
        let buckets = CalendarBuckets.build(todo: [], history: [done], series: [],
                                            from: "2026-09-01", to: "2026-09-30")
        XCTAssertEqual(buckets["2026-09-10"]?.history.map(\.id), ["a"])
        XCTAssertTrue(buckets["2026-09-14"]?.deadlines.isEmpty ?? true, "a completed deadline is not open work")
        XCTAssertNil(buckets["2026-09-14"])
    }

    func testOpenCountIsWorkPlannedForTheDayAndExcludesDeadlinesLandingFromElsewhere() {
        let here = task("a", scheduledDate: "2026-09-14")
        let elsewhere = task("b", scheduledDate: "2026-09-10", dueDate: "2026-09-14")
        let buckets = CalendarBuckets.build(todo: [here, elsewhere], history: [], series: [],
                                            from: "2026-09-01", to: "2026-09-30")
        // Counting the deadline here would make a week's headers exceed the week's actual work.
        XCTAssertEqual(buckets["2026-09-14"]?.openCount, 1)
        XCTAssertEqual(buckets["2026-09-14"]?.deadlines.count, 1)
    }

    func testTasksOutsideTheRangeAreIgnored() {
        let buckets = CalendarBuckets.build(todo: [task("a", scheduledDate: "2026-08-31")], history: [], series: [],
                                            from: "2026-09-01", to: "2026-09-30")
        XCTAssertTrue(buckets.isEmpty)
    }

    func testMaterialisedInstancesSuppressTheirProjectedGhost() {
        let series = Series(id: "s1", title: "每日站会", notes: nil, project: nil, priority: .none,
                            estimateMinutes: nil, rule: .daily, scheduledTime: "09:00", reminderTime: nil,
                            timezone: "Asia/Shanghai", startDate: "2026-09-01", endDate: nil, status: .active,
                            stoppedAt: nil, generatedThrough: "2026-09-01", version: 1,
                            createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z")
        // The runtime has since generated 09-02 but the cached `generatedThrough` still says 09-01.
        let real = task("t1", scheduledDate: "2026-09-02", seriesId: "s1", occurrenceDate: "2026-09-02")
        let buckets = CalendarBuckets.build(todo: [real], history: [], series: [series],
                                            from: "2026-09-01", to: "2026-09-04")
        XCTAssertEqual(buckets["2026-09-02"]?.planned.map(\.id), ["t1"])
        XCTAssertTrue(buckets["2026-09-02"]?.ghosts.isEmpty ?? true, "a real row must not be shadowed by a ghost")
        XCTAssertEqual(buckets["2026-09-03"]?.ghosts.count, 1)
    }
}
