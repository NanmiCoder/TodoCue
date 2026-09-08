import XCTest
@testable import TodoCue

/// What the grid and agenda actually get: panel height, minus the header (~90pt at the route's
/// title size), minus the quick-add row pinned underneath.
private let pageHeight: (CGFloat) -> CGFloat = { $0 - 90 - CalendarLayout.quickAdd }

final class CalendarLayoutTests: XCTestCase {
    func testShortestPanelCollapsesTheGridInsteadOfStarvingTheAgenda() {
        // 360pt is the panel minimum. A six-row month at its smallest cell would leave under one
        // task row of agenda, so the grid must fall back to a single week.
        let month = CalendarLayout.metrics(available: pageHeight(360), weekRows: 6)
        XCTAssertTrue(month.collapsed)
        XCTAssertEqual(month.rows, 1)
        XCTAssertGreaterThanOrEqual(month.agendaHeight, CalendarLayout.agendaMin)

        // At the panel minimum no month fits alongside a usable agenda, four-row months included;
        // the chevron still lets the reader force one open and accept a shorter agenda.
        XCTAssertTrue(CalendarLayout.metrics(available: pageHeight(360), weekRows: 5).collapsed)
        XCTAssertTrue(CalendarLayout.metrics(available: pageHeight(360), weekRows: 4).collapsed)
        // A short month can still be forced open there; a six-row one no longer fits on the page
        // at all once the quick-add row is accounted for, so the toggle is not offered.
        XCTAssertTrue(CalendarLayout.canExpand(available: pageHeight(360), weekRows: 4))
        XCTAssertFalse(CalendarLayout.canExpand(available: pageHeight(360), weekRows: 6))
    }

    func testExpansionThresholds() {
        // chrome (56) + agendaMin (120) + minCell * rows, expressed as panel heights.
        XCTAssertFalse(CalendarLayout.metrics(available: pageHeight(463), weekRows: 5).collapsed)
        XCTAssertTrue(CalendarLayout.metrics(available: pageHeight(462), weekRows: 5).collapsed)
        XCTAssertFalse(CalendarLayout.metrics(available: pageHeight(491), weekRows: 6).collapsed)
        XCTAssertTrue(CalendarLayout.metrics(available: pageHeight(490), weekRows: 6).collapsed)
    }

    /// The grid does not clip, so a cell shorter than its content overlaps its neighbours.
    func testNoReachableConfigurationDrawsACellShorterThanItsContent() {
        for available in stride(from: CGFloat(150), through: 1200, by: 5) {
            for rows in 1...6 {
                for forced in [nil, true, false] as [Bool?] {
                    let m = CalendarLayout.metrics(available: available, weekRows: rows, forceExpanded: forced)
                    XCTAssertGreaterThanOrEqual(m.cellHeight, CalendarLayout.cellContent,
                                                "available=\(available) rows=\(rows) forced=\(String(describing: forced))")
                }
            }
        }
    }

    func testDefaultPanelGivesAComfortableGridAndAgenda() {
        let metrics = CalendarLayout.metrics(available: pageHeight(680), weekRows: 5)
        XCTAssertFalse(metrics.collapsed)
        XCTAssertEqual(metrics.cellHeight, CalendarLayout.maxCell)
        XCTAssertEqual(metrics.gridHeight, CalendarLayout.maxCell * 5)
        XCTAssertGreaterThan(metrics.agendaHeight, 300)
    }

    func testAnExplicitToggleOverridesTheAutomaticDecisionInBothDirections() {
        // Forcing a month open trades agenda height for grid rows, but only while the grid still
        // fits the page: at 470pt a six-row month opens with a shorter agenda than the ladder
        // would pick, and at 360pt the request is refused rather than clipped.
        let forcedOpen = CalendarLayout.metrics(available: pageHeight(470), weekRows: 6, forceExpanded: true)
        XCTAssertFalse(forcedOpen.collapsed)
        XCTAssertEqual(forcedOpen.rows, 6)
        XCTAssertGreaterThan(forcedOpen.agendaHeight, 0)
        XCTAssertLessThan(forcedOpen.agendaHeight, CalendarLayout.agendaMin)
        XCTAssertTrue(CalendarLayout.metrics(available: pageHeight(360), weekRows: 6, forceExpanded: true).collapsed)
        let forcedShut = CalendarLayout.metrics(available: pageHeight(680), weekRows: 5, forceExpanded: false)
        XCTAssertTrue(forcedShut.collapsed)
        XCTAssertEqual(forcedShut.rows, 1)
    }

    /// Forcing a grid open must never leave so little room that focusing the quick-add row
    /// pushes it off the bottom of the panel.
    func testAnExpandedGridAlwaysLeavesRoomForAFocusedQuickAdd() {
        for available in stride(from: CGFloat(150), through: 1200, by: 5) {
            for rows in 1...6 where CalendarLayout.canExpand(available: available, weekRows: rows) {
                let m = CalendarLayout.metrics(available: available, weekRows: rows, forceExpanded: true)
                XCTAssertGreaterThanOrEqual(m.agendaHeight, CalendarLayout.quickAddFocused,
                                            "available=\(available) rows=\(rows)")
            }
        }
    }

    func testTheLadderAlwaysPartitionsTheAvailableHeightWithoutNegativeSpace() {
        for available in stride(from: CGFloat(150), through: 900, by: 10) {
            for rows in 4...6 {
                for forced in [nil, true, false] as [Bool?] {
                    let m = CalendarLayout.metrics(available: available, weekRows: rows, forceExpanded: forced)
                    let label = "available=\(available) rows=\(rows) forced=\(String(describing: forced))"
                    XCTAssertGreaterThanOrEqual(m.cellHeight, CalendarLayout.minCell, label)
                    XCTAssertGreaterThanOrEqual(CalendarLayout.minCell, CalendarLayout.cellContent, label)
                    XCTAssertLessThanOrEqual(m.cellHeight, CalendarLayout.maxCell, label)
                    XCTAssertGreaterThanOrEqual(m.agendaHeight, 0, label)
                    XCTAssertEqual(m.gridHeight, m.cellHeight * CGFloat(m.rows), accuracy: 0.001, label)
                    XCTAssertEqual(m.rows, m.collapsed ? 1 : rows, label)
                    // The pane heights never claim more room than the page has.
                    XCTAssertLessThanOrEqual(CalendarLayout.navigator + CalendarLayout.weekdayHeader
                                             + m.gridHeight + m.agendaHeight, max(available, 0) + 0.001, label)
                }
            }
        }
    }

    func testCanExpandReportsWhetherTheGridWouldStillFitOnThePage() {
        // Every panel height the user can actually reach (>= 360) leaves room for the override.
        XCTAssertTrue(CalendarLayout.canExpand(available: pageHeight(680), weekRows: 6))
        // Below that the grid would be clipped, so the toggle is refused rather than honoured.
        XCTAssertFalse(CalendarLayout.canExpand(available: 150, weekRows: 6))
        XCTAssertTrue(CalendarLayout.metrics(available: 150, weekRows: 6, forceExpanded: true).collapsed)
    }
}
