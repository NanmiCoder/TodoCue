import SwiftUI
import TodoCueKit

/// Animated tactile checkbox with spring feedback.
struct CheckButton: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    let task: TodoTask
    @State private var hovered = false

    var body: some View {
        Button {
            if task.status == .done { model.reopen(task) }
            else { model.complete(task) }
        } label: {
            ZStack {
                Circle()
                    .strokeBorder(
                        isDone ? accent : (hovered ? accent : Color.secondary.opacity(0.5)),
                        lineWidth: isDone ? 0 : (hovered ? 1.6 : 1.4)
                    )
                if hovered && !isDone {
                    Circle()
                        .fill(accent.opacity(0.16))
                        .frame(width: 11, height: 11)
                }
                Circle().fill(accent)
                    .scaleEffect(isDone ? 1 : 0.2)
                    .opacity(isDone ? 1 : 0)
                // Finishing draws the mark rather than popping it in.
                CheckmarkShape()
                    .trim(from: 0, to: isDone ? 1 : 0)
                    .stroke(Color.white, style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
                    .frame(width: 11, height: 11)
                    .animation(Theme.reduceMotion ? nil : .easeOut(duration: 0.22).delay(0.06), value: isDone)
            }
            .animation(Dial.pop, value: isDone)
            .frame(width: 18, height: 18)
            .scaleEffect(hovered && !isDone && !Theme.reduceMotion ? 1.06 : 1.0)
            .animation(Theme.interaction, value: hovered)
            // Press in, overshoot, settle — one continuous gesture when a task is finished.
            .keyframeAnimator(initialValue: 1.0, trigger: isDone) { content, scale in
                content.scaleEffect(scale)
            } keyframes: { _ in
                if isDone && !Theme.reduceMotion {
                    CubicKeyframe(0.82, duration: 0.08)
                    SpringKeyframe(1.16, duration: 0.16, spring: .snappy)
                    SpringKeyframe(1.0, duration: 0.3, spring: .smooth)
                } else {
                    LinearKeyframe(1.0, duration: 0.01)
                }
            }
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
    private var finishing: Bool { task.status == .todo && model.completingTaskIDs.contains(task.id) }

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
                        // A task being finished already reads as done during its completion beat.
                        .strikethrough(task.status != .todo || finishing, color: Color.secondary.opacity(0.55))
                        .foregroundStyle(task.status == .todo && !finishing ? Color.primary : Color.secondary.opacity(0.6))
                        .animation(.easeOut(duration: 0.2), value: finishing)
                    TaskMetadataView(task: task, showProject: showProject, omitsTodayTime: true)
                }
                .padding(.top, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L10n.tr("打开任务 \(task.title)"))
            DialTimeBadge(task: task).padding(.trailing, 4)
        }
        .padding(.vertical, compact ? 3 : 5)
        .padding(.horizontal, 5)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(hovering ? Color.primary.opacity(0.06) : .clear))
        .onHover { hovering = $0 }
        .animation(Theme.interaction, value: hovering)
        .contextMenu { TaskContextMenu(task: task) }
    }
}

/// Lay out complete facts; a time or duration never breaks between its value and unit.
struct TaskMetadataView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    let task: TodoTask
    var showProject = true
    var emphasized = false
    /// Rows that show today's time in their trailing badge leave it out of this line.
    var omitsTodayTime = false

    private var items: [TaskMeta.Item] {
        TaskMeta.items(for: task, includeProject: showProject,
                       includeScheduled: !(omitsTodayTime && DialTimeBadge.text(for: task) != nil))
    }

    var body: some View {
        FlowLayout(spacing: 7, rowSpacing: 3) {
            if task.priority == .high && !emphasized {
                Image(systemName: "flag.fill").font(.system(size: 10)).foregroundStyle(task.priority.color)
                    .accessibilityLabel(L10n.tr("高优先级"))
            }
            ForEach(items) { item in
                if item.id == .project {
                    Text(item.text)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.18), lineWidth: 0.5))
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
