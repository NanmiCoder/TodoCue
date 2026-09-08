import Foundation

/// Date parsing/formatting helpers shared by app and helper.
public enum TCDate {
    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let dateOnly: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static let localNoOffset: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return f
    }()

    /// Parse ISO-8601 instants with or without fractional seconds.
    public static func parse(_ s: String) -> Date? {
        if let d = isoFractional.date(from: s) { return d }
        if let d = isoPlain.date(from: s) { return d }
        return nil
    }

    /// Format an instant as ISO-8601 UTC with milliseconds.
    public static func iso(_ d: Date) -> String { isoFractional.string(from: d) }

    /// Local ISO date-time without offset (interpreted by the runtime in its timezone).
    public static func localISO(_ d: Date) -> String { localNoOffset.string(from: d) }

    public static func localDateString(_ d: Date) -> String { dateOnly.string(from: d) }

    public static func parseLocalDate(_ s: String) -> Date? {
        // `DateFormatter` rolls an impossible date over — 2026-02-30 comes back as March 2 — and the
        // runtime validates `YYYY-MM-DD` by regex alone, so such a value is storable by any client.
        // Rendering it as a different, real date is worse than refusing it.
        guard CivilDate.parse(s) != nil else { return nil }
        return dateOnly.date(from: s)
    }

    public static func dateString(_ date: Date, timezone: String) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: timezone) ?? .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    public static func todayString() -> String { localDateString(Date()) }

    public static func tomorrowString() -> String {
        localDateString(Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date())
    }

    private static func display(_ date: Date, template: String, language: AppLanguage? = nil) -> String {
        let formatter = DateFormatter()
        formatter.locale = (language ?? L10n.language).locale
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter.string(from: date)
    }

    public static func time(_ d: Date) -> String { display(d, template: "HHmm") }
    public static func day(_ d: Date) -> String { display(d, template: "MMMd") }
    public static func dayWithWeekday(_ d: Date) -> String { display(d, template: "MMM d EEE") }

    /// Human label for an instant: today → "HH:mm", otherwise "M月d日 HH:mm".
    public static func instantLabel(_ iso: String) -> String {
        guard let d = parse(iso) else { return iso }
        if Calendar.current.isDateInToday(d) { return time(d) }
        if Calendar.current.isDateInTomorrow(d) { return L10n.tr("明天 ") + time(d) }
        return display(d, template: "MMMd HHmm")
    }

    /// Human label for a local date string: relative wording near today, otherwise an absolute
    /// date that keeps its year whenever it is not the current one — the completed history and the
    /// calendar both reach years away, where a bare "Jan 1" is indistinguishable from this year's.
    public static func dateLabel(_ s: String, language: AppLanguage? = nil,
                                 today: String = todayString()) -> String {
        let language = language ?? L10n.language
        switch s {
        case today: return L10n.tr("今天", language: language)
        case addingDays(1, to: today): return L10n.tr("明天", language: language)
        case addingDays(-1, to: today): return L10n.tr("昨天", language: language)
        default: break
        }
        guard let d = parseLocalDate(s) else { return s }
        return display(d, template: s.prefix(4) == today.prefix(4) ? "MMM d EEE" : "y MMM d EEE",
                       language: language)
    }

    public static func addingDays(_ n: Int, to s: String) -> String {
        guard let d = parseLocalDate(s), let r = Calendar.current.date(byAdding: .day, value: n, to: d) else { return s }
        return localDateString(r)
    }
}
