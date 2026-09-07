import SwiftUI
import TodoCueKit

/// Animated mint checkbox used in rows and cards.
struct CheckButton: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    let task: TodoTask
    var body: some View {
        Button {
            if task.status == .done { model.reopen(task) }
            else { model.complete(task) }
        } label: {
            ZStack {
                Circle().strokeBorder(isDone ? accent : Color.secondary.opacity(0.5), lineWidth: 1.3)
                if isDone {
                    Circle().fill(accent)
                    Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
                }
            }
            .frame(width: 18, height: 18)
            .frame(width: 26, height: 26)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!model.canWrite || model.completingTaskIDs.contains(task.id))
        .accessibilityLabel(task.status == .done ? "重新打开 \(task.title)" : "完成 \(task.title)")
    }

    private var isDone: Bool { task.status == .done || model.completingTaskIDs.contains(task.id) }
}

struct TaskRowView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    let task: TodoTask
    var reasons: [TodayReason] = []
    var showProject = true
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            CheckButton(task: task)
            Button { model.routes.append(.detail(task.id)) } label: {
                VStack(alignment: .leading, spacing: 5) {
                    Text(task.title)
                        .font(.system(size: 14, weight: task.priority == .high ? .medium : .regular))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                        .strikethrough(task.status != .todo)
                        .foregroundStyle(task.status == .todo ? Color.primary : Color.secondary)
                    let meta = TaskMeta.line(for: task, includeProject: showProject)
                    HStack(spacing: 6) {
                        if task.priority == .high {
                            Image(systemName: "flag.fill").font(.system(size: 10)).foregroundStyle(task.priority.color)
                                .accessibilityLabel("高优先级")
                        }
                        if !meta.isEmpty {
                            Text(meta).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                        }
                        if task.hasReminder { Image(systemName: "bell").accessibilityLabel("已设置提醒") }
                        if task.isSeriesInstance { Image(systemName: "repeat").accessibilityLabel("重复任务") }
                    }
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                }
                .padding(.top, 3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("打开任务 \(task.title)")
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 3)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(hovering ? Color.primary.opacity(0.045) : .clear))
        .onHover { hovering = $0 }
        .contextMenu { TaskContextMenu(task: task) }
        .transition(.opacity)
    }
}

struct TaskContextMenu: View {
    @EnvironmentObject var model: AppModel
    let task: TodoTask

    var body: some View {
        Group {
            if task.status == .todo {
                Button("完成") { model.complete(task) }
                Button("稍后提醒 10 分钟") { model.snooze(task) }
                Button("改期到明天") { model.moveToTomorrow(task) }
                Button("编辑…") { model.edit(task) }
                Divider()
                Button("取消", role: .destructive) { model.cancel(task) }
                if task.isSeriesInstance { Button("跳过本次") { model.skip(task) } }
            } else {
                Button("重新打开") { model.reopen(task) }
                Button("编辑…") { model.edit(task) }
            }
        }
        .disabled(!model.canWrite)
    }
}
