import Foundation

/// How much of the calendar page goes to the grid and how much to the agenda.
///
/// The panel can be dragged down to 360pt, which leaves the calendar route about 270pt. A six-row
/// month grid at its minimum cell height plus a usable agenda does not fit in that, so below the
/// threshold the grid collapses to the single week containing the selected day. Pure statics, in
/// the shape of `PanelGeometry`, so the ladder is testable without a window.
enum CalendarLayout {
    static let navigator: CGFloat = 38
    static let weekdayHeader: CGFloat = 18
    /// Roughly three task rows — below this the agenda stops being worth showing.
    static let agendaMin: CGFloat = 120
    /// What a cell actually draws: a 20pt number (the selected day's filled circle) + 2 + a 6pt
    /// mark row. `minCell` may never fall below it — the grid has no clipping, so a shorter cell
    /// would paint its marks into the row beneath and its number into the row above.
    static let cellContent: CGFloat = 28
    static let minCell: CGFloat = cellContent
    static let maxCell: CGFloat = 34

    struct Metrics: Equatable {
        let cellHeight: CGFloat
        let gridHeight: CGFloat
        let agendaHeight: CGFloat
        /// Week rows actually drawn — `weekRows`, or 1 once collapsed.
        let rows: Int
        let collapsed: Bool
    }

    /// - Parameters:
    ///   - available: page height, i.e. panel height minus the header.
    ///   - weekRows: week rows the anchored month spans (4…6), or 1 for a week span.
    ///   - forceExpanded: an explicit user toggle, which always wins over the automatic decision.
    static func metrics(available: CGFloat, weekRows: Int, forceExpanded: Bool? = nil) -> Metrics {
        let rows = max(1, weekRows)
        let chrome = navigator + weekdayHeader
        let budget = available - chrome - agendaMin
        let fits = budget >= minCell * CGFloat(rows)
        // An explicit expand may eat into the agenda, but never past the bottom of the page:
        // beyond that the grid would simply be clipped, which is worse than staying collapsed.
        let possible = canExpand(available: available, weekRows: rows)
        let collapsed = forceExpanded.map { !$0 || !possible } ?? !fits
        let shown = collapsed ? 1 : rows
        let cell = min(maxCell, max(minCell, budget / CGFloat(shown)))
        let grid = cell * CGFloat(shown)
        return Metrics(cellHeight: cell, gridHeight: grid,
                       agendaHeight: max(0, available - chrome - grid),
                       rows: shown, collapsed: collapsed)
    }

    /// Whether the user can meaningfully expand a collapsed grid at this height.
    static func canExpand(available: CGFloat, weekRows: Int) -> Bool {
        available - navigator - weekdayHeader >= minCell * CGFloat(max(1, weekRows))
    }
}
