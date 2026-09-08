import Foundation
import TodoCueKit

/// Builds the secondary text line for a task row.
enum TaskMeta {
    enum Kind: Hashable { case scheduled, deadline, project, estimate }
    struct Item: Identifiable {
        let id: Kind
        let text: String
    }

    static func items(for t: TodoTask, includeProject: Bool = true, includeDeadline: Bool = true) -> [Item] {
        var parts: [Item] = []
        if let value = scheduledLabel(t) { parts.append(Item(id: .scheduled, text: value)) }
        if includeDeadline {
            if let value = dueLabel(t) { parts.append(Item(id: .deadline, text: L10n.tr("截止 ") + value)) }
        }
        if includeProject, let p = t.project, !p.isEmpty { parts.append(Item(id: .project, text: p)) }
        if let m = t.estimateMinutes, m > 0 { parts.append(Item(id: .estimate, text: estimateLabel(m))) }
        return parts
    }

    static func line(for t: TodoTask, includeProject: Bool = true, includeDeadline: Bool = true) -> String {
        items(for: t, includeProject: includeProject, includeDeadline: includeDeadline).map(\.text).joined(separator: " · ")
    }

    static func estimateLabel(_ m: Int) -> String {
        if m >= 60 { return m % 60 == 0 ? L10n.tr("\(m / 60) 小时") : L10n.tr("\(m / 60) 小时 \(m % 60) 分") }
        return L10n.tr("\(m) 分钟")
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
