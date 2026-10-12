import Foundation

public enum PeriodicMode: String, Codable, CaseIterable, Sendable {
    case fixed
    case afterCompletion = "after_completion"
    public var label: String {
        switch self {
        case .fixed: return L10n.tr("固定时间点")
        case .afterCompletion: return L10n.tr("完成后重新计时")
        }
    }
}
public struct PeriodicTimeWindow: Codable, Equatable, Sendable, Identifiable {
    public var start: String
    public var end: String
    public var id: String { "\(start)-\(end)" }
    public init(start: String, end: String) { self.start = start; self.end = end }
}
public struct PeriodicConfiguration: Codable, Equatable, Sendable {
    public var title: String
    public var intervalMinutes: Int
    public var weekdays: [Int]
    public var windows: [PeriodicTimeWindow]
    public var mode: PeriodicMode
    public var timezone: String
    public var enabled: Bool
    public init(title: String = "", intervalMinutes: Int = 30, weekdays: [Int] = Array(1...7),
                windows: [PeriodicTimeWindow] = [.init(start: "09:00", end: "18:00")],
                mode: PeriodicMode = .fixed, timezone: String, enabled: Bool = true) {
        self.title = title; self.intervalMinutes = intervalMinutes; self.weekdays = weekdays
        self.windows = windows; self.mode = mode; self.timezone = timezone; self.enabled = enabled
    }
    public var daysLabel: String {
        if weekdays.count == 7 { return L10n.tr("每天") }
        return weekdays.map { Self.dayLabel($0) }.joined(separator: "、")
    }
    public static func dayLabel(_ day: Int) -> String {
        switch day {
        case 1: return L10n.tr("周一")
        case 2: return L10n.tr("周二")
        case 3: return L10n.tr("周三")
        case 4: return L10n.tr("周四")
        case 5: return L10n.tr("周五")
        case 6: return L10n.tr("周六")
        default: return L10n.tr("周日")
        }
    }
    public var localizedSummary: String {
        "\(daysLabel) · \(windows.map { "\($0.start)–\($0.end)" }.joined(separator: "、")) · \(L10n.tr("每 \(intervalMinutes) 分钟"))"
            + (mode == .afterCompletion ? " · \(mode.label)" : "")
    }
}
public struct PeriodicOccurrence: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var ruleId: String
    public var ruleVersion: Int
    public var scheduledAt: String
    public var fireAt: String
    public var round: Int
    public var delivery: String
    public var result: String
    public var channel: String?
    public var offeredAt: String?
    public var claimToken: String?
    public var claimedAt: String?
    public var displayedAt: String?
    public var handledAt: String?
    public var lastError: String?
    public var createdAt: String
    public var updatedAt: String
}
public struct PeriodicReminder: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var intervalMinutes: Int
    public var weekdays: [Int]
    public var windows: [PeriodicTimeWindow]
    public var mode: PeriodicMode
    public var timezone: String
    public var enabled: Bool
    public var version: Int
    public var revision: Int?
    public var pausedOn: String?
    public var stateDate: String
    public var nextFireAt: String?
    public var currentOccurrenceId: String?
    public var currentOccurrence: PeriodicOccurrence?
    public var createdAt: String
    public var updatedAt: String
    public var summary: String
    public var state: String
    public var configuration: PeriodicConfiguration {
        .init(title: title, intervalMinutes: intervalMinutes, weekdays: weekdays, windows: windows,
              mode: mode, timezone: timezone, enabled: enabled)
    }
    public var stateLabel: String {
        switch state {
        case "waiting": return L10n.tr("等待确认")
        case "paused_today": return L10n.tr("今天暂停")
        case "paused": return L10n.tr("已暂停")
        default: return Self.nextLabel(nextFireAt, timezone: timezone)
        }
    }
    public static func nextLabel(_ instant: String?, timezone: String, now: Date = Date()) -> String {
        guard let instant, let date = TCDate.parse(instant) else { return L10n.tr("暂无下一次提醒") }
        let formatter = DateFormatter()
        formatter.timeZone = TimeZone(identifier: timezone)
        formatter.locale = L10n.language.locale
        let today = TCDate.dateString(now, timezone: timezone)
        formatter.dateFormat = TCDate.dateString(date, timezone: timezone) == today ? "HH:mm" : "MM-dd HH:mm"
        let text = formatter.string(from: date)
        return TCDate.dateString(date, timezone: timezone) == today ? L10n.tr("下一次：今天 \(text)") : L10n.tr("下一次：\(text)")
    }
}

extension PeriodicReminder {
    /// Same rule the runtime uses: a selected ISO weekday and `start <= minute < end` in one window,
    /// read in the rule's own timezone. Disabled rules are never active.
    public func isActive(at date: Date = Date()) -> Bool {
        guard enabled, let zone = TimeZone(identifier: timezone) else { return false }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let parts = calendar.dateComponents([.weekday, .hour, .minute], from: date)
        guard let weekday = parts.weekday, let hour = parts.hour, let minute = parts.minute else { return false }
        // Calendar counts Sunday as 1; the runtime counts Monday as 1 and Sunday as 7.
        guard weekdays.contains((weekday + 5) % 7 + 1) else { return false }
        let now = hour * 60 + minute
        return windows.contains { window in
            guard let start = Self.minuteOfDay(window.start), let end = Self.minuteOfDay(window.end) else { return false }
            return now >= start && now < end
        }
    }

    static func minuteOfDay(_ text: String) -> Int? {
        let parts = text.split(separator: ":")
        guard parts.count == 2, let hour = Int(parts[0]), let minute = Int(parts[1]) else { return nil }
        return hour * 60 + minute
    }

    /// Whole minutes since the current occurrence was due, or nil while nothing is pending.
    public func waitingMinutes(now: Date = Date()) -> Int? {
        guard let occurrence = currentOccurrence, occurrence.result == "pending",
              let due = TCDate.parse(occurrence.fireAt) else { return nil }
        return max(0, Int(now.timeIntervalSince(due) / 60))
    }
}

extension APIClient {
    public struct PeriodicEnvelope: Codable, Sendable { public var reminder: PeriodicReminder }
    public struct PeriodicListEnvelope: Codable, Sendable { public var reminders: [PeriodicReminder] }
    public struct PeriodicPreview: Codable, Sendable {
        public var config: PeriodicConfiguration; public var summary: String; public var nextFireAt: String?
    }
    public struct PeriodicActionResult: Codable, Sendable { public var reminder: PeriodicReminder?; public var deleted: Bool?; public var id: String? }
    public func periodicReminders() async throws -> [PeriodicReminder] {
        let result: PeriodicListEnvelope = try await send("GET", "/v1/periodic-reminders")
        return result.reminders
    }
    public func periodicReminder(_ id: String) async throws -> PeriodicReminder {
        let result: PeriodicEnvelope = try await send("GET", "/v1/periodic-reminders/\(id)")
        return result.reminder
    }
    public func previewPeriodic(_ config: PeriodicConfiguration) async throws -> PeriodicPreview {
        try await send("POST", "/v1/periodic-reminders/preview", json: config)
    }
    public func previewPeriodic(_ fields: [String: JSONValue]) async throws -> PeriodicPreview {
        try await send("POST", "/v1/periodic-reminders/preview", json: fields)
    }
    public func createPeriodic(_ config: PeriodicConfiguration, idempotencyKey: String) async throws -> PeriodicReminder {
        let result: PeriodicEnvelope = try await send("POST", "/v1/periodic-reminders", json: config, idempotencyKey: idempotencyKey)
        return result.reminder
    }
    public func createPeriodic(_ fields: [String: JSONValue], idempotencyKey: String) async throws -> PeriodicReminder {
        let result: PeriodicEnvelope = try await send("POST", "/v1/periodic-reminders", json: fields, idempotencyKey: idempotencyKey)
        return result.reminder
    }
    public func updatePeriodic(_ id: String, config: PeriodicConfiguration, version: Int, idempotencyKey: String) async throws -> PeriodicReminder {
        var fields = try JSONDecoder().decode([String: JSONValue].self, from: JSONEncoder().encode(config))
        fields["expectedVersion"] = .int(version)
        let result: PeriodicEnvelope = try await send("PATCH", "/v1/periodic-reminders/\(id)", json: fields, idempotencyKey: idempotencyKey)
        return result.reminder
    }
    public func periodicAction(_ id: String, action: String, version: Int? = nil, occurrenceId: String? = nil,
                               round: Int? = nil, minutes: Int? = nil, idempotencyKey: String = UUID().uuidString) async throws -> PeriodicActionResult {
        var fields: [String: JSONValue] = ["action": .string(action)]
        if let version { fields["expectedVersion"] = .int(version) }
        if let occurrenceId { fields["occurrenceId"] = .string(occurrenceId) }
        if let round { fields["round"] = .int(round) }
        if let minutes { fields["minutes"] = .int(minutes) }
        return try await send("POST", "/v1/periodic-reminders/\(id)/action", json: fields, idempotencyKey: idempotencyKey)
    }
    public func claimPeriodic(_ id: String, occurrenceId: String, round: Int, token: String) async throws -> PeriodicReminder {
        let result: PeriodicEnvelope = try await send("POST", "/v1/periodic-reminders/\(id)/claim",
            json: ["occurrenceId": JSONValue.string(occurrenceId), "round": .int(round), "token": .string(token)])
        return result.reminder
    }
    public func periodicReceipt(_ id: String, occurrenceId: String, round: Int, token: String, displayed: Bool) async throws {
        let _: PeriodicEnvelope = try await send("POST", "/v1/periodic-reminders/\(id)/receipt",
            json: ["occurrenceId": JSONValue.string(occurrenceId), "round": .int(round), "token": .string(token), "displayed": .bool(displayed)])
    }
}
