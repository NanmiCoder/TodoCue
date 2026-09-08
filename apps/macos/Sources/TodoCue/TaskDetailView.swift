import SwiftUI
import TodoCueKit

struct TaskDetailView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    let taskId: String
    @State private var confirmStop = false

    private var task: TodoTask? { model.task(taskId) }

    var body: some View {
        if let task {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        VStack(alignment: .leading, spacing: 14) {
                            statusLine(task)
                            Text(task.title)
                                .font(.system(size: 22, weight: .semibold)).tracking(-0.45)
                                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                            if let notes = task.notes, !notes.isEmpty {
                                Text(notes).font(.system(size: 13)).lineSpacing(3)
                                    .foregroundStyle(.secondary).textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .padding(.horizontal, 16).padding(.vertical, 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Label(L10n.tr("附件\(task.attachments.isEmpty ? "" : " · \(task.attachments.count)")"), systemImage: "paperclip")
                                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
                                Spacer()
                                Button(L10n.tr("添加 / 管理")) { model.edit(task) }.buttonStyle(CueButtonStyle()).disabled(!model.canWrite)
                                    .accessibilityLabel(L10n.tr("管理任务附件"))
                            }
                            if task.attachments.isEmpty {
                                Text(L10n.tr("把图片、文档和灵感放在一起。")) .font(.system(size: 12)).foregroundStyle(.secondary)
                            } else {
                                AttachmentGallery(attachments: task.attachments)
                            }
                        }.padding(16).cueSurface()
                        EditorSection(title: L10n.tr("安排"), icon: "calendar") { fields(task) }
                        if let sid = task.seriesId { seriesBlock(sid, task: task) }
                        reminderLine(task).padding(.horizontal, 6)
                    }
                    .padding(.horizontal, 12).padding(.bottom, 16)
                }
                actions(task).padding(.horizontal, 16).padding(.vertical, 12)
            }
            .task(id: task.seriesId) { if let sid = task.seriesId { await model.loadSeries(sid) } }
        } else {
            VStack(spacing: 10) {
                if model.isLoading { ProgressView() }
                Text(L10n.tr("未找到该任务")).foregroundStyle(.secondary)
                Button(L10n.tr("返回")) { model.pop() }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private func statusLine(_ t: TodoTask) -> some View {
        FlowLayout(spacing: 8) {
            switch t.status {
            case .todo:
                if t.isOverdue { Label(L10n.tr("逾期"), systemImage: "exclamationmark.circle.fill").foregroundStyle(.red) }
                else { Label(L10n.tr("待办"), systemImage: "circle") }
            case .done:
                Label(L10n.tr("已完成") + (t.completedAt.map { " · " + TCDate.instantLabel($0) } ?? ""), systemImage: "checkmark.circle.fill").foregroundStyle(accent)
            case .cancelled: Label(L10n.tr("已取消"), systemImage: "xmark.circle")
            case .skipped: Label(L10n.tr("已跳过"), systemImage: "forward.circle")
            }
            if t.priority != .none {
                Label(L10n.tr("优先级 \(t.priority.label)"), systemImage: t.priority.symbol ?? "flag").foregroundStyle(t.priority.color)
            }
        }
        .font(.system(size: 12))
        .foregroundStyle(.secondary)
    }

    private func fields(_ t: TodoTask) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            field(L10n.tr("项目"), t.project, "folder")
            field(L10n.tr("预计耗时"), t.estimateMinutes.map(TaskMeta.estimateLabel), "timer")
            field(L10n.tr("计划"), TaskMeta.scheduledLabel(t), "calendar")
            field(L10n.tr("截止"), TaskMeta.dueLabel(t), "flag.checkered")
            field(L10n.tr("提醒"), t.reminderAt.map(TCDate.instantLabel), "bell")
            field(L10n.tr("时区"), t.timezone, "globe")
        }
        .font(.system(size: 13))
    }

    @ViewBuilder
    private func field(_ name: String, _ value: String?, _ icon: String) -> some View {
        if let value {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: icon).frame(width: 16).foregroundStyle(.secondary)
                Text(name).foregroundStyle(.secondary).frame(width: 64, alignment: .leading)
                Text(value).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private func seriesBlock(_ sid: String, task: TodoTask) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            FlowLayout(spacing: 8) {
                Image(systemName: "repeat").foregroundStyle(.secondary)
                if let s = model.seriesById[sid] {
                    Text([s.rule.label, s.scheduledTime, s.status == .stopped ? L10n.tr("已停止") : nil].compactMap { $0 }.joined(separator: " · "))
                } else {
                    Text(L10n.tr("重复任务"))
                }
                if model.seriesById[sid]?.status != .stopped {
                    Button(L10n.tr("停止系列")) { confirmStop = true }
                        .controlSize(.small)
                        .disabled(!model.canWrite)
                        .confirmationDialog(L10n.tr("停止这个重复系列？"), isPresented: $confirmStop) {
                            Button(L10n.tr("停止系列"), role: .destructive) { model.stopSeries(sid) }
                            Button(L10n.tr("取消"), role: .cancel) {}
                        } message: {
                            Text(L10n.tr("今天之后尚未开始的实例会被取消，历史记录保留。"))
                        }
                }
            }
            Text(L10n.tr("编辑、改期、完成和跳过只影响本次实例。"))
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
                case .pending: return L10n.tr("提醒待发送 · ") + TCDate.instantLabel(r.fireAt)
                case .submitted: return L10n.tr("提醒已提交系统") + (r.submittedAt.map { " · " + TCDate.instantLabel($0) } ?? "")
                case .failed: return L10n.tr("提醒发送失败") + (r.lastError.map { "：\($0)" } ?? "")
                case .missed: return L10n.tr("错过的提醒已合并提示")
                case .cancelled: return L10n.tr("提醒已取消")
                }
            }()
            Label(text, systemImage: r.status == .failed ? "bell.slash" : "bell.badge")
                .font(.system(size: 12))
                .foregroundStyle(r.status == .failed ? .orange : .secondary)
        }
    }

    private func actions(_ task: TodoTask) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Button { model.edit(task) } label: { Label(L10n.tr("编辑"), systemImage: "pencil") }
                    .buttonStyle(CueButtonStyle())
                if task.status == .todo {
                    Menu {
                        ForEach([10, 30, 60], id: \.self) { minutes in
                            Button(L10n.tr("\(minutes) 分钟后")) { model.snooze(task, minutes: minutes) }
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Label(L10n.tr("稍后提醒"), systemImage: "bell.badge")
                            Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
                        }
                            .font(.system(size: 12, weight: .medium)).padding(.horizontal, 12).frame(height: 32)
                            .background(Color.primary.opacity(0.055), in: Capsule())
                    }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .accessibilityLabel(L10n.tr("稍后提醒"))
                    Spacer(minLength: 0)
                    Menu {
                        Button(L10n.tr("改期到明天")) { model.moveToTomorrow(task) }
                        if task.isSeriesInstance {
                            Button(L10n.tr("跳过本次")) { model.skip(task); model.pop() }
                        }
                        Divider()
                        Button(L10n.tr("取消任务"), role: .destructive) { model.cancel(task); model.pop() }
                    } label: { Image(systemName: "ellipsis").frame(width: 30, height: 32) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).frame(width: 30)
                    .accessibilityLabel(L10n.tr("更多任务操作"))
                } else { Spacer() }
            }
            Button {
                if task.status == .todo { model.complete(task); model.pop() }
                else { model.reopen(task) }
            } label: {
                Label(task.status == .todo ? L10n.tr("标记完成") : L10n.tr("重新打开"), systemImage: task.status == .todo ? "checkmark" : "arrow.uturn.backward")
                    .frame(maxWidth: .infinity).padding(.vertical, 3)
            }
            .buttonStyle(CueButtonStyle(prominent: true))
            .disabled(model.completingTaskIDs.contains(task.id))
        }
        .disabled(!model.canWrite)
    }
}
