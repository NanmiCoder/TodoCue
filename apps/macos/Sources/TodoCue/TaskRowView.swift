import SwiftUI
import TodoCueKit

/// Animated mint checkbox used in rows and cards.
struct CheckButton: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    let task: TodoTask
    @State private var checked = false

    var body: some View {
        Button {
            guard model.canWrite else { return }
            if task.status == .done {
                model.reopen(task)
            } else {
                withAnimation(Theme.reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.25, dampingFraction: 0.7)) { checked = true }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) {
                    model.complete(task)
                    checked = false
                }
            }
        } label: {
            ZStack {
                Circle().strokeBorder(isDone ? accent : Color.secondary.opacity(0.6), lineWidth: 1.4)
                if isDone {
                    Circle().fill(accent)
                    Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
                }
            }
            .frame(width: 18, height: 18)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!model.canWrite)
        .accessibilityLabel(task.status == .done ? "重新打开 \(task.title)" : "完成 \(task.title)")
        .padding(.top, 1)
    }

    private var isDone: Bool { checked || task.status == .done }
}

struct TaskRowView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    let task: TodoTask
    var reasons: [TodayReason] = []
    var showProject = true
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            CheckButton(task: task)
            Button { model.routes.append(.detail(task.id)) } label: {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if let s = task.priority.symbol {
                            Image(systemName: s).font(.system(size: 9, weight: .bold)).foregroundStyle(task.priority.color)
                                .accessibilityLabel("优先级 \(task.priority.label)")
                        }
                        Text(task.title)
                            .font(.system(size: 14))
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .strikethrough(task.status != .todo)
                            .foregroundStyle(task.status == .todo ? Color.primary : Color.secondary)
                        if task.hasReminder {
                            Image(systemName: "bell.fill").font(.system(size: 9)).foregroundStyle(.secondary)
                                .accessibilityLabel("已设置提醒")
                        }
                        if task.isSeriesInstance {
                            Image(systemName: "repeat").font(.system(size: 9)).foregroundStyle(.secondary)
                                .accessibilityLabel("重复任务")
                        }
                    }
                    let meta = TaskMeta.line(for: task, includeProject: showProject)
                    HStack(spacing: 6) {
                        if task.isOverdue {
                            Label("逾期", systemImage: "exclamationmark.circle").font(.system(size: 11, weight: .medium)).foregroundStyle(.red)
                        }
                        if !meta.isEmpty {
                            Text(meta).font(.system(size: 12)).foregroundStyle(task.isOverdue ? .red : .secondary).lineLimit(1)
                        }
                        ForEach(reasons.filter { $0 != .overdue }, id: \.self) { r in
                            Text(r.label)
                                .font(.system(size: 10, weight: .medium))
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Color.secondary.opacity(0.12), in: Capsule())
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("打开任务 \(task.title)")
        }
        .padding(.vertical, 7)
        .padding(.horizontal, 8)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(hovering ? Color.primary.opacity(0.05) : .clear))
        .onHover { hovering = $0 }
        .contextMenu { TaskContextMenu(task: task) }
        .transition(Theme.reduceMotion ? .opacity : .asymmetric(insertion: .opacity, removal: .opacity.combined(with: .scale(scale: 0.96))))
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
