import Foundation
import TodoCueKit

/// Builds the secondary text line for a task row.
enum TaskMeta {
    static func line(for t: TodoTask, includeProject: Bool = true, includeDeadline: Bool = true) -> String {
        var parts: [String] = []
        if let at = t.scheduledAt { parts.append(TCDate.instantLabel(at)) }
        else if let d = t.scheduledDate { parts.append(TCDate.dateLabel(d)) }
        if includeDeadline {
            if let at = t.dueAt { parts.append("截止 " + TCDate.instantLabel(at)) }
            else if let d = t.dueDate { parts.append("截止 " + TCDate.dateLabel(d)) }
        }
        if includeProject, let p = t.project, !p.isEmpty { parts.append(p) }
        if let m = t.estimateMinutes, m > 0 { parts.append(estimateLabel(m)) }
        return parts.joined(separator: " · ")
    }

    static func estimateLabel(_ m: Int) -> String {
        if m >= 60 { return m % 60 == 0 ? "\(m / 60) 小时" : "\(m / 60) 小时 \(m % 60) 分" }
        return "\(m) 分钟"
    }

    static func dueLabel(_ t: TodoTask) -> String? {
        if let at = t.dueAt { return TCDate.instantLabel(at) }
        if let d = t.dueDate { return TCDate.dateLabel(d) }
        return nil
    }

    static func scheduledLabel(_ t: TodoTask) -> String? {
        if let at = t.scheduledAt { return TCDate.instantLabel(at) }
        if let d = t.scheduledDate { return TCDate.dateLabel(d) }
        return nil
    }
}
