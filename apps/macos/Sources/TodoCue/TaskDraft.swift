import Foundation
import TodoCueKit

enum DateMode: String, CaseIterable, Identifiable, Equatable {
    case none, date, dateTime
    var id: String { rawValue }
    var label: String {
        switch self { case .none: return L10n.tr("无"); case .date: return L10n.tr("日期"); case .dateTime: return L10n.tr("日期和时间") }
    }
}

enum RepeatKind: String, CaseIterable, Identifiable, Equatable {
    case none, daily, weekly
    var id: String { rawValue }
    var label: String {
        switch self { case .none: return L10n.tr("不重复"); case .daily: return L10n.tr("每日"); case .weekly: return L10n.tr("每周") }
    }
}

/// Editable form state for creating or editing a task.
struct TaskDraft: Equatable {
    var editingTaskId: String?
    var version: Int?
    var isSeriesInstance = false

    var existingAttachments: [TaskAttachment] = []
    var pendingAttachments: [PendingAttachment] = []
    var removedAttachmentIds: Set<String> = []
    var saveIdempotencyKey = UUID().uuidString
    var title = ""
    var notes = ""
    var project = ""
    var priority: Priority = .none
    var estimate = ""

    var scheduledMode: DateMode = .none
    var scheduledDate = TaskDraft.defaultDate()
    var dueMode: DateMode = .none
    var dueDate = TaskDraft.defaultDate(hour: 18)
    var reminderOn = false
    var reminderDate = TaskDraft.defaultDate(hour: 9, minutesAhead: 30)

    var repeatKind: RepeatKind = .none
    var weekdays: Set<Int> = [Calendar.current.component(.weekday, from: Date()) == 1 ? 7 : Calendar.current.component(.weekday, from: Date()) - 1]
    var repeatTimeOn = false
    var repeatTime = TaskDraft.defaultDate(hour: 9)
    var repeatReminderOn = false
    var repeatReminderTime = TaskDraft.defaultDate(hour: 8, minute: 50)
    var repeatStart = TaskDraft.defaultDate()

    init() {}

    init(editing t: TodoTask) {
        existingAttachments = t.attachments
        editingTaskId = t.id
        version = t.version
        isSeriesInstance = t.isSeriesInstance
        title = t.title
        notes = t.notes ?? ""
        project = t.project ?? ""
        priority = t.priority
        estimate = t.estimateMinutes.map(String.init) ?? ""
        if let d = t.scheduledDate, let date = TCDate.parseLocalDate(d) { scheduledMode = .date; scheduledDate = date }
        else if let at = t.scheduledAt, let date = TCDate.parse(at) { scheduledMode = .dateTime; scheduledDate = date }
        if let d = t.dueDate, let date = TCDate.parseLocalDate(d) { dueMode = .date; dueDate = date }
        else if let at = t.dueAt, let date = TCDate.parse(at) { dueMode = .dateTime; dueDate = date }
        if let r = t.reminderAt, let date = TCDate.parse(r) { reminderOn = true; reminderDate = date }
    }

    static func defaultDate(hour: Int = 9, minute: Int = 0, minutesAhead: Int? = nil) -> Date {
        if let m = minutesAhead {
            let d = Date().addingTimeInterval(Double(m) * 60)
            let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: d)
            return Calendar.current.date(from: comps) ?? d
        }
        var comps = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        comps.hour = hour; comps.minute = minute
        return Calendar.current.date(from: comps) ?? Date()
    }

    var isEditing: Bool { editingTaskId != nil }

    var hasContent: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !notes.isEmpty || !project.isEmpty || priority != .none || !estimate.isEmpty || scheduledMode != .none || dueMode != .none || reminderOn || repeatKind != .none || !pendingAttachments.isEmpty || !removedAttachmentIds.isEmpty
    }

    func validate() -> String? {
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return L10n.tr("请输入标题") }
        if !estimate.isEmpty, Int(estimate) == nil || Int(estimate)! < 0 { return L10n.tr("预计耗时需要是非负整数分钟") }
        if repeatKind == .weekly, weekdays.isEmpty { return L10n.tr("每周重复至少选择一天") }
        let kept = existingAttachments.filter { !removedAttachmentIds.contains($0.id) }
        if kept.count + pendingAttachments.count > AttachmentLimits.count { return L10n.tr("每个任务最多 20 个附件") }
        if kept.reduce(0, { $0 + $1.size }) + pendingAttachments.reduce(0, { $0 + $1.data.count }) > AttachmentLimits.totalBytes { return L10n.tr("附件总大小不能超过 30 MB") }
        return nil
    }

    private static let hhmm: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "HH:mm"; return f
    }()

    private func commonFields(into p: inout TaskPayload) {
        p.set("title", title.trimmingCharacters(in: .whitespacesAndNewlines))
        p.set("notes", notes.isEmpty ? nil : notes)
        p.set("project", project.trimmingCharacters(in: .whitespaces).isEmpty ? nil : project.trimmingCharacters(in: .whitespaces))
        p.fields["priority"] = .string(priority.rawValue)
        p.set("estimateMinutes", estimate.isEmpty ? nil : Int(estimate))
    }

    private func timeFields(into p: inout TaskPayload) {
        switch scheduledMode {
        case .none: p.set("scheduledDate", nil as String?); p.set("scheduledAt", nil as String?)
        case .date: p.set("scheduledDate", TCDate.localDateString(scheduledDate)); p.set("scheduledAt", nil as String?)
        case .dateTime: p.set("scheduledAt", TCDate.iso(scheduledDate)); p.set("scheduledDate", nil as String?)
        }
        switch dueMode {
        case .none: p.set("dueDate", nil as String?); p.set("dueAt", nil as String?)
        case .date: p.set("dueDate", TCDate.localDateString(dueDate)); p.set("dueAt", nil as String?)
        case .dateTime: p.set("dueAt", TCDate.iso(dueDate)); p.set("dueDate", nil as String?)
        }
        p.set("reminderAt", reminderOn ? TCDate.iso(reminderDate) : nil)
    }

    func createPayload() -> TaskPayload {
        var p = TaskPayload()
        commonFields(into: &p)
        if !pendingAttachments.isEmpty { p.fields["attachments"] = .array(pendingAttachments.map(\.payload)) }
        p.fields["timezone"] = .string(TimeZone.current.identifier)
        if repeatKind == .none {
            timeFields(into: &p)
            // Drop explicit nulls on create; omitted is equivalent and keeps the payload small.
            p.fields = p.fields.filter { $0.value != .null }
        } else {
            p.setRule("repeat", repeatKind == .daily ? .daily : .weekly(weekdays: weekdays.sorted()))
            p.fields["startDate"] = .string(TCDate.localDateString(repeatStart))
            if repeatTimeOn { p.fields["scheduledTime"] = .string(Self.hhmm.string(from: repeatTime)) }
            if repeatReminderOn { p.fields["reminderTime"] = .string(Self.hhmm.string(from: repeatReminderTime)) }
        }
        return p
    }

    func updatePayload() -> TaskPayload {
        var p = TaskPayload()
        commonFields(into: &p)
        timeFields(into: &p)
        if !pendingAttachments.isEmpty { p.fields["addAttachments"] = .array(pendingAttachments.map(\.payload)) }
        if !removedAttachmentIds.isEmpty { p.fields["removeAttachmentIds"] = .array(removedAttachmentIds.sorted().map(JSONValue.string)) }
        return p
    }
}
