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
}
