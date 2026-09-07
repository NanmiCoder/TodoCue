import SwiftUI
import TodoCueKit

struct TaskDetailView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    let taskId: String
    @State private var confirmStop = false

    private var task: TodoTask? { model.task(taskId) }

    var body: some View {
        if let task {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(alignment: .top, spacing: 12) {
                        CheckButton(task: task)
                        Text(task.title)
                            .font(.system(size: 17, weight: .semibold))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    statusLine(task)
                    if let n = task.notes, !n.isEmpty {
                        Text(n).font(.system(size: 13)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                    fields(task)
                    if let sid = task.seriesId { seriesBlock(sid, task: task) }
                    reminderLine(task)
                    actions(task)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
            }
            .task(id: task.seriesId) { if let sid = task.seriesId { await model.loadSeries(sid) } }
        } else {
            VStack(spacing: 10) {
                if model.isLoading { ProgressView() }
                Text("未找到该任务").foregroundStyle(.secondary)
                Button("返回") { model.pop() }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private func statusLine(_ t: TodoTask) -> some View {
        HStack(spacing: 8) {
            switch t.status {
            case .todo:
                if t.isOverdue { Label("逾期", systemImage: "exclamationmark.circle.fill").foregroundStyle(.red) }
                else { Label("待办", systemImage: "circle") }
            case .done:
                Label("已完成" + (t.completedAt.map { " · " + TCDate.instantLabel($0) } ?? ""), systemImage: "checkmark.circle.fill").foregroundStyle(accent)
            case .cancelled: Label("已取消", systemImage: "xmark.circle")
            case .skipped: Label("已跳过", systemImage: "forward.circle")
            }
            if t.priority != .none {
                Label("优先级 \(t.priority.label)", systemImage: t.priority.symbol ?? "flag").foregroundStyle(t.priority.color)
            }
        }
        .font(.system(size: 12))
        .foregroundStyle(.secondary)
    }

    private func fields(_ t: TodoTask) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            field("项目", t.project, "folder")
            field("预计耗时", t.estimateMinutes.map(TaskMeta.estimateLabel), "timer")
            field("计划", TaskMeta.scheduledLabel(t), "calendar")
            field("截止", TaskMeta.dueLabel(t), "flag.checkered")
            field("提醒", t.reminderAt.map(TCDate.instantLabel), "bell")
            field("时区", t.timezone, "globe")
        }
        .font(.system(size: 13))
    }

    @ViewBuilder
    private func field(_ name: String, _ value: String?, _ icon: String) -> some View {
        if let value {
            HStack(spacing: 8) {
                Image(systemName: icon).frame(width: 16).foregroundStyle(.secondary)
                Text(name).foregroundStyle(.secondary).frame(width: 64, alignment: .leading)
                Text(value).textSelection(.enabled)
            }
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private func seriesBlock(_ sid: String, task: TodoTask) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "repeat").foregroundStyle(.secondary)
                if let s = model.seriesById[sid] {
                    Text([s.rule.label, s.scheduledTime, s.status == .stopped ? "已停止" : nil].compactMap { $0 }.joined(separator: " · "))
                } else {
                    Text("重复任务")
                }
                Spacer()
                if model.seriesById[sid]?.status != .stopped {
                    Button("停止系列") { confirmStop = true }
                        .controlSize(.small)
                        .disabled(!model.canWrite)
                        .confirmationDialog("停止这个重复系列？", isPresented: $confirmStop) {
                            Button("停止系列", role: .destructive) { model.stopSeries(sid) }
                            Button("取消", role: .cancel) {}
                        } message: {
                            Text("今天之后尚未开始的实例会被取消，历史记录保留。")
                        }
                }
            }
            Text("编辑、改期、完成和跳过只影响本次实例。")
                .font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .font(.system(size: 12))
        .padding(10)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    @ViewBuilder
    private func reminderLine(_ t: TodoTask) -> some View {
        if let r = model.remindersByTask[t.id] {
            let text: String = {
                switch r.status {
                case .pending: return "提醒待发送 · " + TCDate.instantLabel(r.fireAt)
                case .submitted: return "提醒已提交系统" + (r.submittedAt.map { " · " + TCDate.instantLabel($0) } ?? "")
                case .failed: return "提醒发送失败" + (r.lastError.map { "：\($0)" } ?? "")
                case .missed: return "错过的提醒已合并提示"
                case .cancelled: return "提醒已取消"
                }
            }()
            Label(text, systemImage: r.status == .failed ? "bell.slash" : "bell.badge")
                .font(.system(size: 12))
                .foregroundStyle(r.status == .failed ? .orange : .secondary)
        }
    }

    private func actions(_ t: TodoTask) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if t.status == .todo {
                    Button { model.complete(t); model.pop() } label: { Label("完成", systemImage: "checkmark") }
                        .buttonStyle(.borderedProminent)
                    Button { model.snooze(t) } label: { Label("稍后提醒", systemImage: "zzz") }
                    Button { model.moveToTomorrow(t) } label: { Label("明天", systemImage: "arrow.turn.down.right") }
                } else {
                    Button { model.reopen(t) } label: { Label("重新打开", systemImage: "arrow.uturn.backward") }
                        .buttonStyle(.borderedProminent)
                }
            }
            HStack(spacing: 8) {
                Button { model.edit(t) } label: { Label("编辑", systemImage: "pencil") }
                if t.status == .todo {
                    Button(role: .destructive) { model.cancel(t); model.pop() } label: { Label("取消", systemImage: "xmark") }
                    if t.isSeriesInstance {
                        Button { model.skip(t); model.pop() } label: { Label("跳过", systemImage: "forward") }
                    }
                }
            }
        }
        .controlSize(.regular)
        .disabled(!model.canWrite)
        .padding(.top, 4)
    }
}
