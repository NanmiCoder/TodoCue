import Foundation

/// Calendar arithmetic on `yyyy-MM-dd` strings, done in integer civil days.
/// Iterating a grid with `Calendar` would parse each date at local midnight, which a DST
/// transition can move or erase; integer days cannot repeat or skip one. Wire dates never
/// become `Date` here — only display formatting does that.
public enum CivilDate {
    public static func isLeap(_ year: Int) -> Bool { (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 }

    public static func daysInMonth(year: Int, month: Int) -> Int {
        switch month {
        case 1, 3, 5, 7, 8, 10, 12: return 31
        case 4, 6, 9, 11: return 30
        case 2: return isLeap(year) ? 29 : 28
        default: return 0
        }
    }

    public static func parse(_ date: String) -> (year: Int, month: Int, day: Int)? {
        let parts = date.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              month >= 1, month <= 12, day >= 1, day <= daysInMonth(year: year, month: month) else { return nil }
        return (year, month, day)
    }

    public static func format(year: Int, month: Int, day: Int) -> String {
        String(format: "%04d-%02d-%02d", year, month, day)
    }

    /// Days since 1970-01-01, valid for any proleptic Gregorian date (Howard Hinnant's algorithm).
    public static func epochDay(year: Int, month: Int, day: Int) -> Int {
        let shifted = year - (month <= 2 ? 1 : 0)
        let era = (shifted >= 0 ? shifted : shifted - 399) / 400
        let yearOfEra = shifted - era * 400
        let dayOfYear = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146097 + dayOfEra - 719468
    }

    public static func epochDay(_ date: String) -> Int? {
        guard let (year, month, day) = parse(date) else { return nil }
        return epochDay(year: year, month: month, day: day)
    }

    public static func date(epochDay: Int) -> String {
        var z = epochDay + 719468
        let era = (z >= 0 ? z : z - 146096) / 146097
        z -= era * 146097
        let yearOfEra = (z - z / 1460 + z / 36524 - z / 146096) / 365
        let year = yearOfEra + era * 400
        let dayOfYear = z - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let monthPrime = (5 * dayOfYear + 2) / 153
        let day = dayOfYear - (153 * monthPrime + 2) / 5 + 1
        let month = monthPrime + (monthPrime < 10 ? 3 : -9)
        return format(year: year + (month <= 2 ? 1 : 0), month: month, day: day)
    }

    public static func adding(_ days: Int, to date: String) -> String {
        guard let start = epochDay(date) else { return date }
        return self.date(epochDay: start + days)
    }

    /// Whole days from `start` to `end`; negative when `end` is earlier.
    public static func between(_ start: String, _ end: String) -> Int {
        guard let a = epochDay(start), let b = epochDay(end) else { return 0 }
        return b - a
    }

    /// ISO weekday, 1 = Monday … 7 = Sunday — the convention used by `RecurrenceRule.weekly`
    /// and by the runtime (luxon). Deliberately independent of `Calendar.current`, whose
    /// `.weekday` component is 1 = Sunday and would be off by one exactly on Sundays.
    public static func isoWeekday(_ date: String) -> Int {
        guard let day = epochDay(date) else { return 1 }
        return (((day + 3) % 7) + 7) % 7 + 1
    }

    /// Adds months, clamping the day to the shorter target month so repeated steps never drift.
    public static func addingMonths(_ months: Int, to date: String) -> String {
        guard let (year, month, day) = parse(date) else { return date }
        let total = year * 12 + (month - 1) + months
        let newYear = total >= 0 ? total / 12 : -((-total + 11) / 12)   // floor division, not truncation
        let newMonth = total - newYear * 12 + 1
        return format(year: newYear, month: newMonth, day: min(day, daysInMonth(year: newYear, month: newMonth)))
    }

    public static func firstOfMonth(_ date: String) -> String {
        guard let (year, month, _) = parse(date) else { return date }
        return format(year: year, month: month, day: 1)
    }

    public static func lastOfMonth(_ date: String) -> String {
        guard let (year, month, _) = parse(date) else { return date }
        return format(year: year, month: month, day: daysInMonth(year: year, month: month))
    }

    public static func isSameMonth(_ a: String, _ b: String) -> Bool {
        a.prefix(7) == b.prefix(7)
    }
}

public enum CalendarSpan: String, CaseIterable, Identifiable, Sendable {
    case month, week

    public var id: String { rawValue }
    /// The segmented control label.
    public var label: String { self == .month ? L10n.tr("按月") : L10n.tr("按周") }
}

public enum CalendarRange {
    /// Chinese calendars start on Monday; otherwise follow the user's region.
    ///
    /// The Chinese case is *not* derived from the locale: Foundation reports `firstWeekday == 1`
    /// (Sunday) for `zh-Hans`, `zh-Hans-CN` and a `zh_CN` system region alike, which contradicts
    /// both the convention and this app's own weekday picker (`RecurrenceRule.label` renders
    /// 一 二 三 四 五 六 日 — Monday first). English is not one convention — en-US starts Sunday,
    /// en-GB and en-AU start Monday — so it defers to the region instead of guessing.
    public static func firstWeekday(_ language: AppLanguage,
                                    region: Int = Calendar.current.firstWeekday) -> Int {
        language == .chinese ? 2 : min(max(region, 1), 7)
    }

    /// The date of the week start containing `date`, for a 1 = Sunday … 7 = Saturday `firstWeekday`.
    public static func startOfWeek(_ date: String, firstWeekday: Int) -> String {
        // isoWeekday is 1 = Monday; convert to the Foundation 1 = Sunday numbering to compare.
        let sundayBased = CivilDate.isoWeekday(date) % 7 + 1
        let back = ((sundayBased - firstWeekday) + 7) % 7
        return CivilDate.adding(-back, to: date)
    }

    /// Every cell the span renders: 7 days for a week, 28/35/42 whole-week-aligned days for a month.
    public static func days(span: CalendarSpan, anchor: String, firstWeekday: Int) -> [String] {
        switch span {
        case .week:
            let start = startOfWeek(anchor, firstWeekday: firstWeekday)
            return (0..<7).map { CivilDate.adding($0, to: start) }
        case .month:
            let start = startOfWeek(CivilDate.firstOfMonth(anchor), firstWeekday: firstWeekday)
            let end = CivilDate.lastOfMonth(anchor)
            let dayCount = CivilDate.between(start, end) + 1
            let rows = (dayCount + 6) / 7
            return (0..<(rows * 7)).map { CivilDate.adding($0, to: start) }
        }
    }

    /// How many week rows a month span occupies — the input to the height ladder.
    public static func weekRows(span: CalendarSpan, anchor: String, firstWeekday: Int) -> Int {
        span == .week ? 1 : days(span: span, anchor: anchor, firstWeekday: firstWeekday).count / 7
    }

    public static func bounds(span: CalendarSpan, anchor: String, firstWeekday: Int) -> (from: String, to: String) {
        let all = days(span: span, anchor: anchor, firstWeekday: firstWeekday)
        return (all.first ?? anchor, all.last ?? anchor)
    }

    public static func shift(span: CalendarSpan, anchor: String, by steps: Int) -> String {
        span == .month ? CivilDate.addingMonths(steps, to: anchor) : CivilDate.adding(steps * 7, to: anchor)
    }

    /// True when `date` is inside the same span as `anchor` — used to dim a month grid's padding days
    /// and to decide whether the "back to today" affordance is needed.
    public static func contains(span: CalendarSpan, anchor: String, date: String, firstWeekday: Int) -> Bool {
        span == .month
            ? CivilDate.isSameMonth(anchor, date)
            : startOfWeek(anchor, firstWeekday: firstWeekday) == startOfWeek(date, firstWeekday: firstWeekday)
    }

    /// Column headers, rotated to `firstWeekday`. Chinese uses the single-character forms that match
    /// the repeat picker; English uses two letters, because "S M T W T F S" is ambiguous.
    public static func weekdaySymbols(firstWeekday: Int, language: AppLanguage) -> [String] {
        let formatter = DateFormatter()
        formatter.locale = language.locale
        let chinese = language == .chinese
        let base = (chinese ? formatter.veryShortWeekdaySymbols : formatter.shortWeekdaySymbols)
            ?? ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
        return (0..<7).map { index in
            let symbol = base[(index + firstWeekday - 1) % 7]
            return chinese ? symbol : String(symbol.prefix(2))
        }
    }

    /// "2026年9月" / "Sep 2026" for a month, "9月7日 – 9月13日" / "Sep 7 – Sep 13" for a week.
    /// The month uses `yMMM`, not `yMMMM`: at the 300pt panel minimum the navigator leaves this
    /// label under 90pt, which "September 2026" cannot hold without shrinking to an unreadable size.
    /// A week outside the current year carries the year too — this view pages to arbitrary dates,
    /// where "Mar 4 – Mar 10" alone would be the same string every year.
    public static func title(span: CalendarSpan, anchor: String, firstWeekday: Int,
                             language: AppLanguage, today: String = TCDate.todayString()) -> String {
        let formatter = DateFormatter()
        formatter.locale = language.locale
        switch span {
        case .month:
            guard let date = TCDate.parseLocalDate(anchor) else { return anchor }
            formatter.setLocalizedDateFormatFromTemplate("yMMM")
            return formatter.string(from: date)
        case .week:
            let start = startOfWeek(anchor, firstWeekday: firstWeekday)
            let end = CivilDate.adding(6, to: start)
            let sameYear = start.prefix(4) == today.prefix(4) && end.prefix(4) == today.prefix(4)
            formatter.setLocalizedDateFormatFromTemplate(sameYear ? "MMMd" : "yMMMd")
            let left = TCDate.parseLocalDate(start).map { formatter.string(from: $0) } ?? start
            let right = TCDate.parseLocalDate(end).map { formatter.string(from: $0) } ?? end
            return "\(left) – \(right)"
        }
    }

    /// The agenda's day heading. Relative wording near today, otherwise an absolute date that keeps
    /// its year whenever the date is not in the current year — `TCDate.dateLabel` drops the year,
    /// which is fine for lists bounded to the near future but ambiguous in a calendar.
    public static func dayLabel(_ date: String, language: AppLanguage,
                               today: String = TCDate.todayString()) -> String {
        // Resolve against the passed language, not the global preference: taking `language` for the
        // formatter and ignoring it for the words would make this untestable and quietly divergent.
        switch CivilDate.between(today, date) {
        case 0: return L10n.tr("今天", language: language)
        case 1: return L10n.tr("明天", language: language)
        case -1: return L10n.tr("昨天", language: language)
        default: break
        }
        guard let parsed = TCDate.parseLocalDate(date) else { return date }
        let formatter = DateFormatter()
        formatter.locale = language.locale
        formatter.setLocalizedDateFormatFromTemplate(date.prefix(4) == today.prefix(4) ? "MMM d EEE" : "y MMM d EEE")
        return formatter.string(from: parsed)
    }
}

/// Everything one calendar cell needs to render, precomputed once per visible range.
public struct CalendarDayBucket: Hashable, Sendable {
    public var planned: [TodoTask] = []
    public var history: [TodoTask] = []
    public var deadlines: [TodoTask] = []
    public var ghosts: [SeriesProjection.Ghost] = []

    public init() {}

    public var isEmpty: Bool { planned.isEmpty && history.isEmpty && deadlines.isEmpty && ghosts.isEmpty }
    public var hasOverdue: Bool { planned.contains { $0.isOverdue } || deadlines.contains { $0.isOverdue } }
    /// Work planned *for* this day. Deadlines are excluded: they are planned elsewhere, so counting
    /// them here would make a week's headers add up to more than the week's actual work.
    public var openCount: Int { planned.count }
}

public enum CalendarBuckets {
    /// Buckets tasks by the date they belong on. `todo` comes from the board snapshot,
    /// `history` from a ranged query; both are keyed by `planDate`, so a task is never counted twice.
    public static func build(todo: [TodoTask], history: [TodoTask], series: [Series],
                             from: String, to: String) -> [String: CalendarDayBucket] {
        var buckets: [String: CalendarDayBucket] = [:]
        var materialised: Set<String> = []
        // The board snapshot is authoritative for open work. A task that was completed and then
        // reopened elsewhere can still be sitting in a fetched history page; dropping the stale
        // copy here keeps it from appearing twice on the same day.
        let open = Set(todo.map(\.id))

        func inRange(_ date: String) -> Bool { date >= from && date <= to }

        for task in todo + history.filter({ !open.contains($0.id) }) {
            if let seriesId = task.seriesId, let occurrence = task.occurrenceDate {
                materialised.insert(seriesId + "@" + occurrence)
            }
            // Unscheduled tasks belong to no day at all — never fold them into an "" bucket.
            guard let plan = task.planDate else { continue }
            if inRange(plan) {
                if task.status == .todo { buckets[plan, default: .init()].planned.append(task) }
                else { buckets[plan, default: .init()].history.append(task) }
            }
            // A deadline that differs from the plan date deserves its own marker; `planDate`
            // already falls back to the due date, so a due-only task must not be marked twice.
            // Only open work earns one — a finished task's deadline is no longer outstanding.
            if task.status == .todo, let deadline = deadlineDate(task), deadline != plan, inRange(deadline) {
                buckets[deadline, default: .init()].deadlines.append(task)
            }
        }

        for ghost in SeriesProjection.occurrences(series, from: from, to: to, existing: materialised) {
            buckets[ghost.date, default: .init()].ghosts.append(ghost)
        }
        return buckets
    }

    /// The local date a task is due on, if it has a deadline at all.
    public static func deadlineDate(_ task: TodoTask) -> String? {
        if let date = task.dueDate { return date }
        if let at = task.dueAt, let instant = TCDate.parse(at) { return TCDate.dateString(instant, timezone: task.timezone) }
        return nil
    }
}
