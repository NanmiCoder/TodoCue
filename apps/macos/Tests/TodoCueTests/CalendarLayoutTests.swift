import XCTest
@testable import TodoCue

/// The calendar route gets the panel height minus the header (~90pt at the route's title size).
private let pageHeight: (CGFloat) -> CGFloat = { $0 - 90 }

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
        XCTAssertTrue(CalendarLayout.canExpand(available: pageHeight(360), weekRows: 6))
    }

    func testExpansionThresholds() {
        // chrome (56) + agendaMin (120) + minCell * rows, expressed as panel heights.
        XCTAssertFalse(CalendarLayout.metrics(available: pageHeight(406), weekRows: 5).collapsed)
        XCTAssertTrue(CalendarLayout.metrics(available: pageHeight(405), weekRows: 5).collapsed)
        XCTAssertFalse(CalendarLayout.metrics(available: pageHeight(434), weekRows: 6).collapsed)
        XCTAssertTrue(CalendarLayout.metrics(available: pageHeight(433), weekRows: 6).collapsed)
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
        // At the 360pt panel minimum a forced six-row month still fits on the page; it just leaves
        // a shorter agenda than the automatic ladder would choose.
        let forcedOpen = CalendarLayout.metrics(available: pageHeight(360), weekRows: 6, forceExpanded: true)
        XCTAssertFalse(forcedOpen.collapsed)
        XCTAssertEqual(forcedOpen.rows, 6)
        XCTAssertGreaterThan(forcedOpen.agendaHeight, 0)
        XCTAssertLessThan(forcedOpen.agendaHeight, CalendarLayout.agendaMin)
        let forcedShut = CalendarLayout.metrics(available: pageHeight(680), weekRows: 5, forceExpanded: false)
        XCTAssertTrue(forcedShut.collapsed)
        XCTAssertEqual(forcedShut.rows, 1)
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
        XCTAssertTrue(CalendarLayout.canExpand(available: pageHeight(360), weekRows: 6))
        XCTAssertTrue(CalendarLayout.canExpand(available: pageHeight(680), weekRows: 6))
        // Below that the grid would be clipped, so the toggle is refused rather than honoured.
        XCTAssertFalse(CalendarLayout.canExpand(available: 150, weekRows: 6))
        XCTAssertTrue(CalendarLayout.metrics(available: 150, weekRows: 6, forceExpanded: true).collapsed)
    }
}
