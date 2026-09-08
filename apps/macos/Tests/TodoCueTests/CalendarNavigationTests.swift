import XCTest
import TodoCueKit
@testable import TodoCue

/// Offline `AppModel()` — no client, so nothing here reaches a runtime or a database.
final class CalendarNavigationTests: XCTestCase {
    @MainActor func testOpeningTheCalendarDoesNotRequestKeyboardFocus() {
        let model = AppModel()
        var requestedFocus: [Bool] = []
        model.onOpenPanel = { requestedFocus.append($0) }
        model.showCalendar()
        // The calendar has no text field; only explicit editing may steal focus from the front app.
        XCTAssertEqual(requestedFocus, [false])
        XCTAssertEqual(model.routes.last, .calendar)
        XCTAssertTrue(model.isShowingCalendar)
    }

    @MainActor func testOpeningTwiceDoesNotStackTheRoute() {
        let model = AppModel()
        model.showCalendar()
        model.showCalendar()
        XCTAssertEqual(model.routes, [.calendar])
    }

    @MainActor func testAnchorAndSelectionSurviveADetailPushAndPop() {
        let model = AppModel()
        model.showCalendar()
        model.setCalendar(anchor: "2027-03-01", selected: "2027-03-04")
        // Pushing detail unmounts CalendarView entirely, which is why this state lives on the model.
        model.routes.append(.detail("t1"))
        model.pop()
        XCTAssertEqual(model.routes.last, .calendar)
        XCTAssertEqual(model.calendarAnchor, "2027-03-01")
        XCTAssertEqual(model.calendarSelected, "2027-03-04")
    }

    @MainActor func testEscapePopsTheCalendarBeforeClosingThePanel() {
        let model = AppModel()
        var closes = 0
        model.onClosePanel = { closes += 1 }
        model.showCalendar()
        model.handleEscape()
        XCTAssertTrue(model.routes.isEmpty)
        XCTAssertEqual(closes, 0)
        model.handleEscape()
        XCTAssertEqual(closes, 1)
    }

    @MainActor func testOpenTodayClearsTheCalendarRoute() {
        let model = AppModel()
        model.showCalendar()
        model.openToday()
        XCTAssertTrue(model.routes.isEmpty)
        XCTAssertEqual(model.tab, .today)
    }

    @MainActor func testSteppingMovesByOneUnitAndKeepsTheSelectionInsideTheSpan() {
        let model = AppModel()
        model.showCalendar()
        model.setCalendar(span: .month, anchor: "2026-12-15", selected: "2026-12-15")
        model.stepCalendar(1)
        XCTAssertEqual(model.calendarAnchor, "2027-01-15")
        XCTAssertTrue(CalendarRange.contains(span: .month, anchor: model.calendarAnchor,
                                             date: model.calendarSelected,
                                             firstWeekday: model.calendarFirstWeekday))
        model.stepCalendar(-1)
        XCTAssertEqual(model.calendarAnchor, "2026-12-15")

        model.setCalendar(span: .week, anchor: "2026-12-30", selected: "2026-12-30")
        model.stepCalendar(1)
        XCTAssertEqual(model.calendarAnchor, "2027-01-06")
        XCTAssertTrue(CalendarRange.contains(span: .week, anchor: model.calendarAnchor,
                                             date: model.calendarSelected,
                                             firstWeekday: model.calendarFirstWeekday))
    }

    @MainActor func testGoingBackToTodayResetsBothAnchorAndSelection() {
        let model = AppModel()
        model.showCalendar()
        model.setCalendar(anchor: "2027-03-01", selected: "2027-03-04")
        XCTAssertFalse(model.calendarShowsToday)
        model.calendarGoToToday()
        XCTAssertEqual(model.calendarAnchor, TCDate.todayString())
        XCTAssertEqual(model.calendarSelected, TCDate.todayString())
        XCTAssertTrue(model.calendarShowsToday)
    }

    @MainActor func testChangingSpanDropsAnExplicitGridToggle() {
        let model = AppModel()
        model.showCalendar()
        model.calendarGridExpanded = false
        model.setCalendar(span: .week)
        XCTAssertNil(model.calendarGridExpanded)
    }

    @MainActor func testTheCalendarStaysLiveWhileADetailIsPushedOverIt() {
        let model = AppModel()
        model.showCalendar()
        model.routes.append(.detail("t1"))
        // Gating live updates on `routes.last` would freeze the calendar the moment the user opens
        // a task from it, leaving stale rows that then submit a stale expectedVersion.
        XCTAssertTrue(model.isShowingCalendar)
        model.routes.append(.form(TaskDraft()))
        XCTAssertTrue(model.isShowingCalendar)
        model.routes = [.settings]
        XCTAssertFalse(model.isShowingCalendar)
    }

    @MainActor func testReopeningReturnsToTheExistingCalendarInsteadOfStackingAnother() {
        let model = AppModel()
        model.showCalendar()
        model.routes.append(.detail("t1"))
        model.showCalendar()
        XCTAssertEqual(model.routes, [.calendar])
    }

    @MainActor func testOpeningTheCalendarAlwaysStartsOnTheMonthOfToday() {
        let model = AppModel()
        model.showCalendar()
        model.setCalendar(span: .week, anchor: "2027-03-01", selected: "2027-03-04")
        model.pop()
        model.showCalendar()
        // Leaving the span behind is how month scenes silently became week scenes once before.
        XCTAssertEqual(model.calendarSpan, .month)
        XCTAssertEqual(model.calendarAnchor, TCDate.todayString())
        XCTAssertNil(model.calendarGridExpanded)
    }

    @MainActor func testPagingMonthsAndBackReturnsToTheSameDay() {
        let model = AppModel()
        model.showCalendar()
        model.setCalendar(span: .month, anchor: "2026-09-08", selected: "2026-09-08")
        model.stepCalendar(1)
        XCTAssertEqual(model.calendarSelected, "2026-10-08")
        model.stepCalendar(-1)
        XCTAssertEqual(model.calendarSelected, "2026-09-08")
        // A month step must not slide the selection onto the first matching weekday.
        XCTAssertEqual(model.calendarAnchor, "2026-09-08")
    }

    @MainActor func testPagingWeeksKeepsTheWeekday() {
        let model = AppModel()
        model.showCalendar()
        model.setCalendar(span: .week, anchor: "2026-09-08", selected: "2026-09-08") // Tuesday
        model.stepCalendar(1)
        XCTAssertEqual(CivilDate.isoWeekday(model.calendarSelected), 2)
        XCTAssertEqual(model.calendarSelected, "2026-09-15")
    }

    @MainActor func testUnknownDaysReturnAnEmptyBucketRatherThanTrapping() {
        let model = AppModel()
        model.showCalendar()
        XCTAssertTrue(model.calendarBucket("1999-01-01").isEmpty)
        XCTAssertEqual(model.calendarBucket("1999-01-01").openCount, 0)
    }
}
