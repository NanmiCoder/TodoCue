import SwiftUI
import TodoCueKit

/// The glass shell carries navigation; the reading and editing surfaces stay quiet.
struct PanelRootView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            HeaderView()
            if !model.connectionState.isOnline { OfflineBanner().padding(.horizontal, 12).padding(.bottom, 10) }
            content.frame(maxWidth: .infinity, maxHeight: .infinity)
            if let toast = model.toast {
                ToastView(toast: toast)
                    .padding(.bottom, 12)
                    .transition(Theme.reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            }
        }
        .background(Theme.shellTint)
        .animation(Theme.interaction, value: model.toast)
        .animation(Theme.reduceMotion ? nil : .easeOut(duration: 0.18), value: model.routes.count)
        .todoCueAccent()
        .cueScrollEdges()
        .environment(\.locale, languagePreferences.language.locale)
    }

    @ViewBuilder private var content: some View {
        switch model.routes.last {
        case .detail(let id): TaskDetailView(taskId: id).transition(.opacity)
        case .form(let draft): TaskFormView(draft: draft).transition(.opacity)
        case .settings: SettingsView().transition(.opacity)
        case .calendar: CalendarView().transition(.opacity)
        case .completed: CompletedView().transition(.opacity)
        case nil: ListRootView().transition(.opacity)
        }
    }
}

struct HeaderView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 4) {
                if !model.routes.isEmpty {
                    Button { model.pop() } label: { Image(systemName: "chevron.left") }
                        .buttonStyle(QuietIconButtonStyle())
                        .keyboardShortcut("[", modifiers: .command)
                        .accessibilityLabel(L10n.tr("返回"))
                } else {
                    CueMark().padding(.trailing, 5)
                }
                Text("TodoCue").font(.system(size: 12, weight: .semibold)).tracking(0.3).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                if model.isLoading { ProgressView().controlSize(.mini).padding(.trailing, 4) }
                if model.routes.isEmpty {
                    // ⌘⇧K lives in AppDelegate's key monitor with the other panel shortcuts, so it
                    // still works from a sub-route where this button is not mounted.
                    Button(action: model.showCalendar) { Image(systemName: "calendar") }
                        .buttonStyle(QuietIconButtonStyle()).foregroundStyle(.secondary)
                        .help(L10n.tr("打开日历（⌘⇧K）")).accessibilityLabel(L10n.tr("打开日历"))
                }
                Button { model.pinned.toggle() } label: {
                    Image(systemName: model.pinned ? "pin.fill" : "pin")
                        .foregroundStyle(model.pinned ? accent : .secondary)
                }
                .buttonStyle(QuietIconButtonStyle())
                .help(model.pinned ? L10n.tr("取消固定（允许 Esc 收起）") : L10n.tr("固定面板，防止 Esc 误收起"))
                .accessibilityLabel(model.pinned ? L10n.tr("取消固定面板") : L10n.tr("固定面板"))
                Menu {
                    Button(L10n.tr("新建任务"), action: model.newTask).disabled(!model.canWrite)
                    Button(L10n.tr("已完成…"), action: model.showCompleted)
                    Button(L10n.tr("刷新")) { Task { await model.refreshAll() } }
                    Button(L10n.tr("导出 JSON"), action: model.exportJSON).disabled(model.client == nil)
                    Divider()
                    Button(L10n.tr("设置…"), action: model.showSettings)
                    Button(L10n.tr("退出 TodoCue")) { NSApp.terminate(nil) }
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.secondary).frame(width: 30, height: 30)
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).frame(width: 30)
                .accessibilityLabel(L10n.tr("更多操作"))
                Button { model.onClosePanel?() } label: { Image(systemName: "xmark") }
                    .buttonStyle(QuietIconButtonStyle()).foregroundStyle(.secondary)
                    .help(L10n.tr("收起面板，任务与提醒继续运行")).accessibilityLabel(L10n.tr("收起面板"))
            }
            if !isDetail {
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(title).font(.system(size: model.routes.isEmpty ? 26 : 23, weight: .semibold)).tracking(-0.7)
                        if model.routes.isEmpty {
                            Text(subtitle).font(.system(size: 12)).foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 8)
                    if model.routes.isEmpty && model.tab == .today {
                        DayProgressView(completed: model.today.completed.count, remaining: model.remaining)
                    }
                }
                .padding(.horizontal, 4)
            }
        }
        .padding(.horizontal, 18).padding(.top, 10).padding(.bottom, 12)
    }

    private var isDetail: Bool {
        if case .detail = model.routes.last { return true }
        return false
    }

    private var title: String {
        switch model.routes.last {
        case .detail: return L10n.tr("这件事")
        case .form(let draft): return draft.isEditing ? L10n.tr("编辑任务") : L10n.tr("记下一件事")
        case .settings: return L10n.tr("偏好设置")
        case .calendar: return L10n.tr("日历")
        case .completed: return L10n.tr("已完成")
        case nil:
            switch model.tab { case .today: return L10n.tr("今天"); case .upcoming: return L10n.tr("接下来"); case .all: return L10n.tr("所有任务") }
        }
    }
    private var subtitle: String {
        switch model.tab {
        case .today: return model.todayDateLabel
        case .upcoming: return L10n.tr("按计划日期排列")
        case .all: return L10n.tr("\(model.allTasks.count) 件待办 · 按项目整理")
        }
    }
}

struct OfflineBanner: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: model.connectionState == .connecting ? "arrow.triangle.2.circlepath" : "wifi.slash")
            VStack(alignment: .leading, spacing: 1) {
                Text(model.isPreparingRuntime ? L10n.tr("正在准备 TodoCue…") : (model.connectionState == .noRuntime ? L10n.tr("无法连接 TodoCue 运行时") : model.connectionState.label))
                    .font(.system(size: 12, weight: .medium))
                if let error = model.runtimeSetupError {
                    Text(error).font(.system(size: 11)).foregroundStyle(.secondary)
                } else if model.isPreparingRuntime {
                    Text(L10n.tr("首次启动会自动配置后台服务，原有任务会保留"))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                } else if model.connectionState == .noRuntime {
                    Text(L10n.tr("运行 todocue service start 后自动重连"))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                } else if model.connectionState != .connecting {
                    Text(L10n.tr("显示上次数据，已暂停写入"))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button(L10n.tr("重试")) { model.reconnect() }
                .controlSize(.small)
                .disabled(model.isPreparingRuntime)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 8)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .contain)
    }
}

struct ToastView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    let toast: Toast

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: toast.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(toast.isError ? Color.orange : Color(nsColor: .systemMint))
            Text(toast.message)
                .font(.system(size: 12))
                .lineLimit(2)
            Spacer(minLength: 0)
            if let id = toast.undoTaskId {
                Button(L10n.tr("撤销")) { model.undoComplete(id) }
                    .controlSize(.small)
                    .keyboardShortcut("z", modifiers: .command)
            }
            if let undo = toast.undoReschedule {
                Button(L10n.tr("撤销")) { model.undoReschedule(undo) }
                    .controlSize(.small)
                    .keyboardShortcut("z", modifiers: .command)
                    .disabled(!model.canWrite || model.isMovingTask)
            }
            if let token = toast.undoOrderToken, let revision = toast.undoOrderRevision {
                Button(L10n.tr("撤销")) { model.undoOrder(token: token, revision: revision) }
                    .controlSize(.small)
                    .keyboardShortcut("z", modifiers: .command)
                    .disabled(!model.canWrite || model.isMovingTask)
            }
            Button { model.toast = nil } label: {
                Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L10n.tr("关闭提示"))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color.primary.opacity(0.08), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.04), radius: 8, y: 2)
        .padding(.horizontal, 16)
        .accessibilityElement(children: .contain)
    }
}
