import Foundation

/// Recurring instances are real rows in the runtime, generated only 30 days ahead and tracked by
/// `Series.generatedThrough`. A calendar browsing further out would otherwise show empty months, so
/// the client projects the remaining occurrences from the rule itself. They are display-only:
/// an unmaterialised occurrence has no task id and no version, so it cannot be completed.
public enum SeriesProjection {
    public struct Ghost: Identifiable, Hashable, Sendable {
        public let seriesId: String
        public let date: String
        public let title: String
        public let scheduledTime: String?
        public let project: String?
        public let priority: Priority

        public var id: String { seriesId + "@" + date }
    }

    /// Occurrences the runtime has not created yet, within `from...to` inclusive.
    ///
    /// Iteration counts in epoch days rather than walking date strings. The runtime validates
    /// `YYYY-MM-DD` by regex alone (`DateString` in packages/shared), and `createSeries` never calls
    /// `assertDate`, so an impossible date like `2026-02-30` is storable by any CLI or MCP client.
    /// A string cursor advanced by a function that returns its input on a parse failure would sit on
    /// such a date forever, hanging the main actor; a series with one is skipped instead.
    ///
    /// - Parameter existing: `"seriesId@occurrenceDate"` for every instance already known to the
    ///   client, used only as a backstop — see the `generatedThrough` note below.
    public static func occurrences(_ series: [Series], from: String, to: String,
                                   existing: Set<String>) -> [Ghost] {
        guard let first = CivilDate.epochDay(from), let last = CivilDate.epochDay(to), first <= last else { return [] }
        var ghosts: [Ghost] = []
        for item in series where item.status == .active {
            guard let start = CivilDate.epochDay(item.startDate) else { continue }
            // Cut off at `generatedThrough`, not at "no task row exists for this date": the client's
            // snapshot only holds `status == .todo`, so a completed, skipped or cancelled instance
            // inside the horizon has no row, and an existence test would resurrect it as a ghost.
            let generated: Int
            if let through = item.generatedThrough {
                guard let parsed = CivilDate.epochDay(through) else { continue }
                generated = parsed
            } else {
                generated = start - 1
            }
            var end = last
            if let endDate = item.endDate {
                guard let parsed = CivilDate.epochDay(endDate) else { continue }
                end = min(end, parsed)
            }
            var day = max(first, start, generated + 1)
            while day <= end {
                let date = CivilDate.date(epochDay: day)
                if matches(item.rule, date), !existing.contains(item.id + "@" + date) {
                    ghosts.append(Ghost(seriesId: item.id, date: date, title: item.title,
                                        scheduledTime: item.scheduledTime, project: item.project,
                                        priority: item.priority))
                }
                day += 1
            }
        }
        return ghosts
    }

    /// Mirrors the runtime's `matchesRule`: daily always fires, weekly on its ISO weekdays.
    public static func matches(_ rule: RecurrenceRule, _ date: String) -> Bool {
        switch rule {
        case .daily: return true
        case .weekly(let weekdays): return weekdays.contains(CivilDate.isoWeekday(date))
        }
    }
}
