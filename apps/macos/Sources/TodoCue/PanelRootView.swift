import SwiftUI
import TodoCueKit

/// Dial panel: a graphite header tile over the route's own tiles, floating on the desktop with
/// the window transparent between them.
struct PanelRootView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: Dial.gap) {
            HeaderView().dialTile(.graphite).dialReveal(0)
            // Overlapping, not stacked: during a push the old and new pages share one frame
            // instead of briefly splitting the height between them.
            // Deeper pages stack above shallower ones, so whichever page is on top stays opaque
            // until the one beneath it has fully arrived.
            ZStack { content.zIndex(Double(model.routes.count)) }.frame(maxWidth: .infinity, maxHeight: .infinity)
                // Feedback floats over the page and never pushes the list around. Under a pinned
                // quick-add pill it sits just above the pill; on pages whose actions live at the
                // bottom it drops from under the header instead, so it never covers 完成 or 保存.
                .overlay(alignment: toastAtBottom ? .bottom : .top) {
                    if let toast = model.toast {
                        ToastView(toast: toast)
                            .shadow(color: .black.opacity(0.28), radius: 14, y: 6)
                            .padding(.horizontal, 8)
                            .padding(toastAtBottom ? .bottom : .top, toastAtBottom ? CalendarLayout.quickAdd + Dial.gap + 4 : 8)
                            .transition(Theme.reduceMotion ? .opacity
                                        : .offset(y: toastAtBottom ? 16 : -16).combined(with: .opacity)
                                            .combined(with: .scale(scale: 0.96, anchor: toastAtBottom ? .bottom : .top)))
                    }
                }
        }
        .padding(Dial.shellInset)
        .background(DialShell())
        .animation(Dial.settle, value: model.toast)
        // Short and decelerating: a replaced page must be gone before the next keystroke lands.
        .animation(Theme.reduceMotion ? nil : .timingCurve(0.2, 0.8, 0.2, 1, duration: 0.2), value: model.routes.count)
        .todoCueAccent()
        .cueScrollEdges()
        .environment(\.locale, languagePreferences.language.locale)
    }

    @ViewBuilder private var content: some View {
        switch model.routes.last {
        case .detail(let id): TaskDetailView(taskId: id).dialPage().transition(pageTransition)
        case .form(let draft): TaskFormView(draft: draft).id(draft.saveIdempotencyKey).dialPage().transition(pageTransition)
        case .settings: SettingsView().dialPage().transition(pageTransition)
        case .calendar: CalendarView().transition(pageTransition)
        case .completed: CompletedView().transition(pageTransition)
        case nil: ListRootView().transition(pageTransition)
        }
    }

    /// The list and the calendar end in a quick-add pill; every other page ends in its own actions.
    private var toastAtBottom: Bool {
        switch model.routes.last {
        case nil, .calendar: return true
        default: return false
        }
    }

    /// There is never a frame where both pages are half-transparent and the desktop flashes through.
    private var pageTransition: AnyTransition {
        if Theme.reduceMotion { return .opacity }
        // The new page covers fast (ease-out) while the old one lets go slowly at first (ease-in),
        // so their combined coverage never dips; the old page is gone within 0.1s, before a
        // replaced form could still take a keystroke.
        return .asymmetric(
            insertion: AnyTransition.offset(y: 14).animation(.spring(response: 0.34, dampingFraction: 0.9))
                .combined(with: AnyTransition.opacity.animation(.easeOut(duration: 0.12))),
            removal: .opacity.animation(.easeIn(duration: 0.1)))
    }
}

extension View {
    /// A pushed route's single frosted page tile.
    func dialPage() -> some View { padding(.top, 8).dialTile(.frost).dialReveal(1) }
}

struct HeaderView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 6) {
                if !model.routes.isEmpty {
                    Button { model.pop() } label: { Image(systemName: "chevron.left") }
                        .buttonStyle(QuietIconButtonStyle())
                        .keyboardShortcut("[", modifiers: .command)
                        .accessibilityLabel(L10n.tr("返回"))
                } else {
                    CueMark().padding(.trailing, 2)
                }
                Text("TodoCue").font(Dial.numeral(12)).foregroundStyle(.white)
                    .fixedSize()
                PanelDragArea().frame(maxWidth: .infinity).frame(height: 30)
                if model.isLoading { ProgressView().controlSize(.mini).padding(.trailing, 4) }
                if model.routes.isEmpty {
                    // ⌘⇧K lives in AppDelegate's key monitor with the other panel shortcuts, so it
                    // still works from a sub-route where this button is not mounted.
                    Button(action: model.showCalendar) { Image(systemName: "calendar") }
                        .buttonStyle(QuietIconButtonStyle()).foregroundStyle(.white.opacity(0.85))
                        .help(L10n.tr("打开日历（⌘⇧K）")).accessibilityLabel(L10n.tr("打开日历"))
                }
                Button { model.pinned.toggle() } label: {
                    Image(systemName: model.pinned ? "pin.fill" : "pin")
                        .foregroundStyle(model.pinned ? accent : .white.opacity(0.85))
                        .rotationEffect(.degrees(model.pinned ? -30 : 0))
                        .animation(Dial.pop, value: model.pinned)
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
                    Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold))
                }
                // A borderless menu draws its label in the tint and drops any background, so the
                // disc sits behind the menu rather than inside its label.
                .menuStyle(.borderlessButton).menuIndicator(.hidden).tint(.white.opacity(0.85))
                .frame(width: 30, height: 30)
                .background(Dial.raised, in: Circle())
                .accessibilityLabel(L10n.tr("更多操作"))
                Button { model.onClosePanel?() } label: { Image(systemName: "xmark") }
                    .buttonStyle(QuietIconButtonStyle()).foregroundStyle(.white.opacity(0.85))
                    .help(L10n.tr("收起面板，任务与提醒继续运行")).accessibilityLabel(L10n.tr("收起面板"))
            }
            ZStack(alignment: .topLeading) {
                if model.routes.isEmpty {
                    rootDial.transition(headerSwap)
                } else if !isDetail {
                    Text(title).font(.system(size: 21, weight: .semibold)).tracking(-0.5).foregroundStyle(.white)
                        .padding(.leading, 2)
                        .id(title)
                        .transition(headerSwap)
                }
            }
            if !model.connectionState.isOnline { OfflineBanner() }
        }
        .padding(.leading, 18).padding(.trailing, 12).padding(.top, 12).padding(.bottom, 18)
        .animation(Dial.snap, value: model.tab)
    }

    /// Root dial and page title replace each other in place; the tile's height follows smoothly.
    private var headerSwap: AnyTransition {
        Theme.reduceMotion ? .opacity
            : .asymmetric(insertion: .opacity.animation(.easeOut(duration: 0.16)),
                          removal: .opacity.animation(.easeIn(duration: 0.08).delay(0.04)))
    }

    private var rootDial: some View {
        VStack(alignment: .leading, spacing: 14) {
                DialTabDots().padding(.leading, 2)
                HStack(alignment: .center, spacing: 14) {
                    DialNumeral(value: headerCount, size: 60)
                        .foregroundStyle(.white)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(caption).font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                        Text(subtitle).font(.system(size: 12)).foregroundStyle(Dial.mutedOnGraphite)
                            .lineLimit(1).minimumScaleFactor(0.85)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.leading, 2)
                .accessibilityElement(children: .combine)
        }
    }

    private var headerCount: Int {
        switch model.tab {
        case .today: return model.remaining
        case .upcoming: return model.upcoming.count
        case .all: return model.allTasks.count
        }
    }

    private var caption: String {
        model.tab == .upcoming ? L10n.tr("件即将到来") : L10n.tr("件待办")
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
        case .today: return L10n.tr("\(model.todayDateLabel) · 已完成 \(model.today.completed.count)")
        case .upcoming: return L10n.tr("按计划日期排列")
        case .all: return L10n.tr("按项目整理")
        }
    }
}

struct OfflineBanner: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: model.connectionState == .connecting ? "arrow.triangle.2.circlepath" : "wifi.slash")
                .foregroundStyle(Dial.orange)
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
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(Dial.orange.opacity(0.16), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
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
                .foregroundStyle(toast.isError ? Theme.overdue : Dial.orange)
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
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .dialTile(.graphite, radius: 24)
        .accessibilityElement(children: .contain)
    }
}
