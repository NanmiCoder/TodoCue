import Foundation

public enum Priority: String, Codable, CaseIterable, Sendable {
    case none, low, medium, high

    public var rank: Int {
        switch self { case .none: return 0; case .low: return 1; case .medium: return 2; case .high: return 3 }
    }

    public var label: String {
        switch self { case .none: return "无"; case .low: return "低"; case .medium: return "中"; case .high: return "高" }
    }
}

public enum TaskStatus: String, Codable, Sendable {
    case todo, done, cancelled, skipped
}

public enum SeriesStatus: String, Codable, Sendable {
    case active, stopped
}

public enum ReminderStatus: String, Codable, Sendable {
    case pending, submitted, failed, missed, cancelled
}

public struct TodoTask: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var title: String
    public var notes: String?
    public var project: String?
    public var priority: Priority
    public var estimateMinutes: Int?
    public var scheduledDate: String?
    public var scheduledAt: String?
    public var dueDate: String?
    public var dueAt: String?
    public var reminderAt: String?
    public var timezone: String
    public var status: TaskStatus
    public var completedAt: String?
    public var seriesId: String?
    public var occurrenceDate: String?
    public var version: Int
    public var createdAt: String
    public var updatedAt: String

    public init(id: String, title: String, notes: String? = nil, project: String? = nil, priority: Priority = .none,
                estimateMinutes: Int? = nil, scheduledDate: String? = nil, scheduledAt: String? = nil,
                dueDate: String? = nil, dueAt: String? = nil, reminderAt: String? = nil, timezone: String,
                status: TaskStatus = .todo, completedAt: String? = nil, seriesId: String? = nil,
                occurrenceDate: String? = nil, version: Int = 1, createdAt: String, updatedAt: String) {
        self.id = id; self.title = title; self.notes = notes; self.project = project; self.priority = priority
        self.estimateMinutes = estimateMinutes; self.scheduledDate = scheduledDate; self.scheduledAt = scheduledAt
        self.dueDate = dueDate; self.dueAt = dueAt; self.reminderAt = reminderAt; self.timezone = timezone
        self.status = status; self.completedAt = completedAt; self.seriesId = seriesId
        self.occurrenceDate = occurrenceDate; self.version = version; self.createdAt = createdAt; self.updatedAt = updatedAt
    }

    public var isSeriesInstance: Bool { seriesId != nil }
    public var hasReminder: Bool { reminderAt != nil }

    /// The local date this task is planned or due on (scheduled first, then due).
    public var planDate: String? {
        if let d = scheduledDate { return d }
        if let at = scheduledAt, let date = TCDate.parse(at) { return TCDate.localDateString(date) }
        if let d = dueDate { return d }
        if let at = dueAt, let date = TCDate.parse(at) { return TCDate.localDateString(date) }
        return nil
    }

    public var isOverdue: Bool {
        guard status == .todo else { return false }
        if let at = dueAt, let d = TCDate.parse(at) { return d < Date() }
        if let d = dueDate { return d < TCDate.localDateString(Date()) }
        return false
    }
}

public enum RecurrenceRule: Codable, Hashable, Sendable {
    case daily
    case weekly(weekdays: [Int])

    enum CodingKeys: String, CodingKey { case kind, weekdays }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "daily": self = .daily
        case "weekly": self = .weekly(weekdays: try c.decode([Int].self, forKey: .weekdays))
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown rule kind \(kind)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .daily: try c.encode("daily", forKey: .kind)
        case .weekly(let weekdays):
            try c.encode("weekly", forKey: .kind)
            try c.encode(weekdays, forKey: .weekdays)
        }
    }

    public var label: String {
        switch self {
        case .daily: return "每日"
        case .weekly(let days):
            let names = ["一", "二", "三", "四", "五", "六", "日"]
            return "每周 " + days.sorted().compactMap { $0 >= 1 && $0 <= 7 ? names[$0 - 1] : nil }.joined(separator: "、")
        }
    }
}

public struct Series: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var title: String
    public var notes: String?
    public var project: String?
    public var priority: Priority
    public var estimateMinutes: Int?
    public var rule: RecurrenceRule
    public var scheduledTime: String?
    public var reminderTime: String?
    public var timezone: String
    public var startDate: String
    public var endDate: String?
    public var status: SeriesStatus
    public var stoppedAt: String?
    public var generatedThrough: String?
    public var version: Int
    public var createdAt: String
    public var updatedAt: String
}

public struct Reminder: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var taskId: String
    public var fireAt: String
    public var status: ReminderStatus
    public var attempts: Int
    public var lastError: String?
    public var submittedAt: String?
    public var channel: String?
    public var createdAt: String
    public var updatedAt: String
}

public enum TodayReason: String, Codable, Sendable {
    case overdue, due_today, scheduled_today, carried_over

    public var label: String {
        switch self {
        case .overdue: return "逾期"
        case .due_today: return "今日截止"
        case .scheduled_today: return "今日计划"
        case .carried_over: return "遗留"
        }
    }
}

public enum TodaySection: String, Codable, Sendable {
    case overdue, must, scheduled

    public var label: String {
        switch self { case .overdue: return "逾期"; case .must: return "必须完成"; case .scheduled: return "已安排" }
    }
}

public struct TodayItem: Codable, Hashable, Identifiable, Sendable {
    public var task: TodoTask
    public var reasons: [TodayReason]
    public var section: TodaySection
    public var id: String { task.id }

    public init(task: TodoTask, reasons: [TodayReason], section: TodaySection) {
        self.task = task; self.reasons = reasons; self.section = section
    }
}

public struct TodayResult: Codable, Sendable {
    public var date: String
    public var timezone: String
    public var now: String
    public var remaining: Int
    public var items: [TodayItem]
    public var completed: [TodoTask]

    public static let empty = TodayResult(date: "", timezone: "", now: "", remaining: 0, items: [], completed: [])
}

public enum NextGroup: String, Codable, Sendable {
    case overdue, due_today, scheduled_reached, unscheduled

    public var label: String {
        switch self {
        case .overdue: return "逾期"
        case .due_today: return "今日截止"
        case .scheduled_reached: return "已到计划时间"
        case .unscheduled: return "未安排"
        }
    }
}

public struct NextCandidate: Codable, Hashable, Sendable {
    public var task: TodoTask
    public var group: NextGroup
    public var reason: String
}

public struct NextResult: Codable, Sendable {
    public var now: String
    public var timezone: String
    public var next: NextCandidate?
    public var candidates: [NextCandidate]
}

public struct ContextInfo: Codable, Sendable {
    public var now: String
    public var timezone: String
    public var today: String
    public var localNow: String
    public var weekday: Int
    public var runtimeVersion: String
}

public enum RuntimeEventType: String, Codable, Sendable {
    case taskCreated = "task.created"
    case taskUpdated = "task.updated"
    case seriesCreated = "series.created"
    case seriesUpdated = "series.updated"
    case reminderUpdated = "reminder.updated"
    case dayChanged = "day.changed"
    case runtimeStarted = "runtime.started"
}

public struct RuntimeEvent: Codable, Sendable {
    public var seq: Int
    public var type: RuntimeEventType
    public var at: String
    public var id: String?
    public var related: [String: String]?
}

public struct DoctorCheck: Codable, Sendable {
    public var name: String
    public var ok: Bool
    public var level: String
    public var detail: String
}

public struct DoctorNotifier: Codable, Sendable {
    public var path: String?
    public var available: Bool
    public var authorization: String
    public var detail: String?
}

public struct DoctorCounts: Codable, Sendable {
    public var tasks: Int
    public var todo: Int
    public var series: Int
    public var pendingReminders: Int
    public var failedReminders: Int
}

public struct DoctorReport: Codable, Sendable {
    public var runtimeVersion: String
    public var nodeVersion: String
    public var home: String
    public var databasePath: String
    public var schemaVersion: Int
    public var timezone: String
    public var baseUrl: String
    public var pid: Int
    public var uptimeSeconds: Double
    public var notifier: DoctorNotifier
    public var counts: DoctorCounts
    public var checks: [DoctorCheck]
}

public struct APIErrorBody: Codable, Sendable {
    public struct Inner: Codable, Sendable {
        public var code: String
        public var message: String
    }
    public var error: Inner
}

// MARK: - Input payloads

/// A JSON value that can carry explicit nulls (used for PATCH clearing fields).
public enum JSONValue: Codable, Hashable, Sendable {
    case string(String), int(Int), bool(Bool), null, array([JSONValue]), object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let i = try? c.decode(Int.self) { self = .int(i) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .int(let i): try c.encode(i)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}

/// Builder for create/update payloads. `nil` = omit, `.null` = clear.
public struct TaskPayload: Sendable {
    public var fields: [String: JSONValue] = [:]
    public init() {}

    public mutating func set(_ key: String, _ value: String?) { fields[key] = value.map { .string($0) } ?? .null }
    public mutating func set(_ key: String, _ value: Int?) { fields[key] = value.map { .int($0) } ?? .null }
    public mutating func setIfPresent(_ key: String, _ value: String?) { if let v = value { fields[key] = .string(v) } }
    public mutating func setIfPresent(_ key: String, _ value: Int?) { if let v = value { fields[key] = .int(v) } }
    public mutating func setRule(_ key: String, _ rule: RecurrenceRule?) {
        guard let rule else { return }
        switch rule {
        case .daily: fields[key] = .object(["kind": .string("daily")])
        case .weekly(let days): fields[key] = .object(["kind": .string("weekly"), "weekdays": .array(days.map { .int($0) })])
        }
    }
}
