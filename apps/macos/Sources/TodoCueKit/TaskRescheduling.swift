import Foundation

/// "Tomorrow" is relative to now, even when a task is several days overdue.
public enum TaskRescheduling {
    public static func tomorrow(_ task: TodoTask, now: Date = Date(), calendar: Calendar = .current) -> TaskPayload {
        let day = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) ?? now
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        let tomorrow = formatter.string(from: day)
        func movedInstant(_ value: String) -> String? {
            guard let date = TCDate.parse(value) else { return nil }
            let time = calendar.dateComponents([.hour, .minute, .second], from: date)
            let moved = calendar.date(bySettingHour: time.hour ?? 9, minute: time.minute ?? 0,
                                      second: time.second ?? 0, of: day) ?? day
            return TCDate.iso(moved)
        }
        var payload = TaskPayload()
        if let at = task.scheduledAt, let moved = movedInstant(at) {
            payload.set("scheduledAt", moved)
            payload.set("scheduledDate", nil as String?)
        } else {
            payload.set("scheduledDate", tomorrow)
            payload.set("scheduledAt", nil as String?)
        }
        // Keep future deadlines; move today's and overdue deadlines out of Today as well.
        if let at = task.dueAt, let date = TCDate.parse(at), date < day, let moved = movedInstant(at) {
            payload.set("dueAt", moved)
            payload.set("dueDate", nil as String?)
        } else if let date = task.dueDate, date < tomorrow {
            payload.set("dueDate", tomorrow)
            payload.set("dueAt", nil as String?)
        }
        return payload
    }

    /// The time of day a task is planned at, read in the task's own timezone.
    private static func planCalendar(_ task: TodoTask) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        // A task carries its own zone, and `TodoTask.planDate` — which decides the calendar cell it
        // is drawn in — resolves in that zone. Doing the arithmetic in the viewer's zone instead
        // would land the task a day off whenever the two disagree.
        calendar.timeZone = TimeZone(identifier: task.timezone) ?? .current
        return calendar
    }

    /// Move a task's plan onto `date`, keeping its time of day. The deadline and the reminder are
    /// left alone — this is the calendar's drag semantics, matching the list's cross-date drag
    /// ("已改期至 X，截止与提醒保持原值") and the runtime's own `moveTask`.
    public static func plan(_ task: TodoTask, on date: String, calendar: Calendar? = nil) -> TaskPayload {
        let calendar = calendar ?? planCalendar(task)
        var payload = TaskPayload()
        guard let at = task.scheduledAt, let instant = TCDate.parse(at) else {
            payload.set("scheduledDate", date)
            payload.set("scheduledAt", nil as String?)
            return payload
        }
        var components = calendar.dateComponents([.hour, .minute, .second], from: instant)
        guard let (year, month, day) = CivilDate.parse(date) else { return payload }
        components.year = year; components.month = month; components.day = day
        guard let moved = calendar.date(from: components) else { return payload }
        payload.set("scheduledAt", TCDate.iso(moved))
        payload.set("scheduledDate", nil as String?)
        return payload
    }

    /// Whether planning `task` on `date` would put the work after its own deadline — the same
    /// condition the runtime raises `DEADLINE_CONFIRMATION_REQUIRED` for (`engine.ts` `moveTask`),
    /// including its second half: a same-day plan whose *time* falls after a `dueAt` instant.
    public static func landsAfterDeadline(_ task: TodoTask, on date: String) -> Bool {
        let calendar = planCalendar(task)
        let dueDay = task.dueDate
            ?? task.dueAt.flatMap { TCDate.parse($0) }.map { TCDate.dateString($0, timezone: task.timezone) }
        guard let dueDay else { return false }
        if date > dueDay { return true }
        guard let dueAt = task.dueAt, let deadline = TCDate.parse(dueAt),
              let moved = plannedInstant(task, on: date, calendar: calendar) else { return false }
        return moved > deadline
    }

    /// Where a timed plan would actually land, for comparing against a `dueAt` instant.
    private static func plannedInstant(_ task: TodoTask, on date: String, calendar: Calendar) -> Date? {
        guard let at = task.scheduledAt, let instant = TCDate.parse(at),
              let (year, month, day) = CivilDate.parse(date) else { return nil }
        var components = calendar.dateComponents([.hour, .minute, .second], from: instant)
        components.year = year; components.month = month; components.day = day
        return calendar.date(from: components)
    }
}
