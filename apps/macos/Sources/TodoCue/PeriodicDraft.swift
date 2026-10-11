import Foundation
import TodoCueKit

struct PeriodicDraft: Equatable {
    var editingId: String?
    var version: Int?
    var saveKey = UUID().uuidString
    var operationKey = UUID().uuidString
    var title = L10n.tr("起来活动一下")
    var interval = "30"
    var weekdays: Set<Int> = Set(1...7)
    var windows = [PeriodicTimeWindow(start: "09:00", end: "18:00")]
    var mode: PeriodicMode = .fixed
    var timezone: String
    var usesRuntimeTimezone = true
    var enabled = true
    init(timezone: String) { self.timezone = timezone }
    init(editing rule: PeriodicReminder) {
        editingId = rule.id; version = rule.version; title = rule.title; interval = String(rule.intervalMinutes)
        weekdays = Set(rule.weekdays); windows = rule.windows; mode = rule.mode; timezone = rule.timezone; enabled = rule.enabled
        usesRuntimeTimezone = false
    }
    func matchesSubmitted(_ submitted: PeriodicDraft) -> Bool {
        var current = self
        // Runtime timezone previews do not change the submitted creation payload.
        if usesRuntimeTimezone && submitted.usesRuntimeTimezone { current.timezone = submitted.timezone }
        return current == submitted
    }
    var configuration: PeriodicConfiguration {
        .init(title: title.trimmingCharacters(in: .whitespacesAndNewlines), intervalMinutes: Int(interval) ?? 0,
              weekdays: weekdays.sorted(), windows: windows, mode: mode, timezone: timezone, enabled: enabled)
    }
    var createFields: [String: JSONValue] {
        let config = configuration
        var fields: [String: JSONValue] = ["title": .string(config.title), "intervalMinutes": .int(config.intervalMinutes),
            "weekdays": .array(config.weekdays.map { .int($0) }),
            "windows": .array(config.windows.map { .object(["start": .string($0.start), "end": .string($0.end)]) }),
            "mode": .string(config.mode.rawValue), "enabled": .bool(config.enabled)]
        if !usesRuntimeTimezone { fields["timezone"] = .string(timezone) }
        return fields
    }
    private func minute(_ value: String, end: Bool = false) -> Int? {
        if end && value == "24:00" { return 1440 }
        guard value.range(of: #"^([01]\d|2[0-3]):[0-5]\d$"#, options: .regularExpression) != nil else { return nil }
        let parts = value.split(separator: ":").compactMap { Int($0) }
        return parts[0] * 60 + parts[1]
    }
    var errors: [String: String] {
        var values: [String: String] = [:]
        if configuration.title.isEmpty { values["title"] = L10n.tr("请输入标题") }
        if configuration.title.count > 500 { values["title"] = L10n.tr("标题最多 500 个字符") }
        if !(1...1440).contains(configuration.intervalMinutes) { values["interval"] = L10n.tr("间隔需要为 1–1440 分钟") }
        if weekdays.isEmpty { values["weekdays"] = L10n.tr("至少选择一天") }
        var ranges: [(Int, Int)] = []
        for window in windows {
            guard let start = minute(window.start), let end = minute(window.end, end: true), end > start else {
                values["windows"] = L10n.tr("请输入有效的起止时间，不支持跨午夜时段"); continue
            }
            ranges.append((start, end))
        }
        if windows.isEmpty { values["windows"] = L10n.tr("至少添加一个时段") }
        ranges.sort { $0.0 < $1.0 }
        for index in ranges.indices.dropFirst() where ranges[index].0 < ranges[index - 1].1 {
            values["windows"] = L10n.tr("生效时段不能重叠")
        }
        if values["windows"] == nil && values["interval"] == nil && !ranges.contains(where: { $0.1 - $0.0 > configuration.intervalMinutes }) {
            values["interval"] = L10n.tr("至少一个时段需要长于提醒间隔")
        }
        if TimeZone(identifier: timezone) == nil { values["timezone"] = L10n.tr("请输入有效的 IANA 时区") }
        return values
    }
    mutating func chooseTemplate(_ value: String) {
        title = value
    }
}
