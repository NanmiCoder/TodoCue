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

    public static func parseLocalDate(_ s: String) -> Date? { dateOnly.date(from: s) }

    public static func todayString() -> String { localDateString(Date()) }

    public static func tomorrowString() -> String {
        localDateString(Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date())
    }

    private static let timeFmt: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN"); f.dateFormat = "HH:mm"; return f
    }()
    private static let dayFmt: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN"); f.dateFormat = "M月d日"; return f
    }()
    private static let dayWeekFmt: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN"); f.dateFormat = "M月d日 EEE"; return f
    }()
    private static let dayTimeFmt: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN"); f.dateFormat = "M月d日 HH:mm"; return f
    }()

    public static func time(_ d: Date) -> String { timeFmt.string(from: d) }
    public static func day(_ d: Date) -> String { dayFmt.string(from: d) }
    public static func dayWithWeekday(_ d: Date) -> String { dayWeekFmt.string(from: d) }

    /// Human label for an instant: today → "HH:mm", otherwise "M月d日 HH:mm".
    public static func instantLabel(_ iso: String) -> String {
        guard let d = parse(iso) else { return iso }
        if Calendar.current.isDateInToday(d) { return time(d) }
        if Calendar.current.isDateInTomorrow(d) { return "明天 " + time(d) }
        return dayTimeFmt.string(from: d)
    }

    /// Human label for a local date string.
    public static func dateLabel(_ s: String) -> String {
        guard let d = parseLocalDate(s) else { return s }
        if Calendar.current.isDateInToday(d) { return "今天" }
        if Calendar.current.isDateInTomorrow(d) { return "明天" }
        if Calendar.current.isDateInYesterday(d) { return "昨天" }
        return dayWithWeekday(d)
    }

    public static func addingDays(_ n: Int, to s: String) -> String {
        guard let d = parseLocalDate(s), let r = Calendar.current.date(byAdding: .day, value: n, to: d) else { return s }
        return localDateString(r)
    }
}
