import SwiftUI
import TodoCueKit

/// Animated tactile checkbox with spring feedback.
struct CheckButton: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    @Environment(\.colorScheme) private var scheme
    let task: TodoTask
    @State private var hovered = false
    @State private var bounce = false

    var body: some View {
        Button {
            withAnimation(Theme.bouncy) {
                bounce = true
            }
            if task.status == .done { model.reopen(task) }
            else { model.complete(task) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                bounce = false
            }
        } label: {
            ZStack {
                Circle()
                    .strokeBorder(
                        isDone ? accent : (hovered ? accent.opacity(0.85) : Color.secondary.opacity(0.38)),
                        lineWidth: isDone ? 1.5 : (hovered ? 1.4 : 1.2)
                    )
                if hovered && !isDone {
                    Circle()
                        .fill(accent.opacity(0.12))
                        .frame(width: 13, height: 13)
                }
                if isDone {
                    Circle().fill(accent)
                    Image(systemName: "checkmark").font(.system(size: 8.5, weight: .bold))
                        .foregroundStyle(scheme == .dark ? Color.black.opacity(0.9) : .white)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .frame(width: 17, height: 17)
            .scaleEffect(bounce && !Theme.reduceMotion ? 1.2 : (hovered && !isDone && !Theme.reduceMotion ? 1.06 : 1.0))
            .animation(Theme.bouncy, value: bounce)
            .animation(Theme.interaction, value: hovered)
            .frame(width: 26, height: 26)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!model.canWrite || model.completingTaskIDs.contains(task.id))
        .onHover { hovered = $0 }
        .accessibilityLabel(task.status == .done ? L10n.tr("重新打开 \(task.title)") : L10n.tr("完成 \(task.title)"))
    }

    private var isDone: Bool { task.status == .done || model.completingTaskIDs.contains(task.id) }
}

struct TaskRowView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    let task: TodoTask
    var reasons: [TodayReason] = []
    var showProject = true
    var compact = false
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            CheckButton(task: task)
                .padding(.top, compact ? 1 : 3)
            Button { model.routes.append(.detail(task.id)) } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.title)
                        .font(.system(size: 13.5, weight: .medium)).tracking(-0.15)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                        .strikethrough(task.status != .todo, color: Color.secondary.opacity(0.55))
                        .foregroundStyle(task.status == .todo ? Color.primary : Color.secondary.opacity(0.6))
                    TaskMetadataView(task: task, showProject: showProject)
                }
                .padding(.top, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L10n.tr("打开任务 \(task.title)"))
        }
        .padding(.vertical, compact ? 3 : 5)
        .padding(.horizontal, 5)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(hovering ? Color.primary.opacity(0.045) : .clear))
        .onHover { hovering = $0 }
        .animation(Theme.interaction, value: hovering)
        .contextMenu { TaskContextMenu(task: task) }
        .transition(.opacity)
    }
}

/// Lay out complete facts; a time or duration never breaks between its value and unit.
struct TaskMetadataView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    let task: TodoTask
    var showProject = true
    var emphasized = false

    var body: some View {
        FlowLayout(spacing: 7, rowSpacing: 3) {
            if task.priority == .high && !emphasized {
                Image(systemName: "flag.fill").font(.system(size: 10)).foregroundStyle(task.priority.color)
                    .accessibilityLabel(L10n.tr("高优先级"))
            }
            ForEach(TaskMeta.items(for: task, includeProject: showProject)) { item in
                if item.id == .project {
                    Text(item.text)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 4))
                } else {
                    Text(item.text)
                        .font(.system(size: 11, weight: item.id == .deadline && emphasized ? .medium : .regular))
                        .foregroundStyle(item.id == .deadline ? (task.isOverdue ? Theme.overdue : Color.primary.opacity(0.85)) : Color.secondary)
                        .lineLimit(1).truncationMode(.middle)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if !task.attachments.isEmpty {
                Label("\(task.attachments.count)", systemImage: "paperclip").accessibilityLabel(L10n.tr("\(task.attachments.count) 个附件"))
            }
            if task.hasReminder { Image(systemName: "bell").accessibilityLabel(L10n.tr("已设置提醒")) }
            if task.isSeriesInstance { Image(systemName: "repeat").accessibilityLabel(L10n.tr("重复任务")) }
        }
        .font(.system(size: 10.5)).foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }
}

struct TaskContextMenu: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    let task: TodoTask

    var body: some View {
        Group {
            if task.status == .todo {
                Button(L10n.tr("完成")) { model.complete(task) }
                Button(L10n.tr("稍后提醒 10 分钟")) { model.snooze(task) }
                Button(L10n.tr("改期到明天")) { model.moveToTomorrow(task) }
                Button(L10n.tr("编辑…")) { model.edit(task) }
                Divider()
                Button(L10n.tr("取消"), role: .destructive) { model.cancel(task) }
                if task.isSeriesInstance { Button(L10n.tr("跳过本次")) { model.skip(task) } }
            } else {
                Button(L10n.tr("重新打开")) { model.reopen(task) }
                Button(L10n.tr("编辑…")) { model.edit(task) }
            }
        }
        .disabled(!model.canWrite)
    }
}
