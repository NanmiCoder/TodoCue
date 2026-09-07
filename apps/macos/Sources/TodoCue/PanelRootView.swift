import SwiftUI
import TodoCueKit

/// Single-column side panel: header → route content (list / detail / form / settings) → toast.
struct PanelRootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ZStack(alignment: .bottom) {
            VStack(spacing: 0) {
                HeaderView()
                if !model.connectionState.isOnline {
                    OfflineBanner()
                }
                Divider().opacity(0.5)
                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if let toast = model.toast {
                ToastView(toast: toast)
                    .padding(.bottom, 14)
                    .transition(Theme.reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(Theme.listChange, value: model.toast)
        .animation(Theme.reduceMotion ? .easeInOut(duration: 0.15) : .easeInOut(duration: 0.2), value: model.routes)
        .todoCueAccent()
        .frame(minWidth: 300, minHeight: 300)
    }

    @ViewBuilder
    private var content: some View {
        switch model.routes.last {
        case .detail(let id):
            TaskDetailView(taskId: id)
                .transition(.opacity)
        case .form(let draft):
            TaskFormView(draft: draft)
                .transition(.opacity)
        case .settings:
            SettingsView()
                .transition(.opacity)
        case nil:
            ListRootView()
                .transition(.opacity)
        }
    }
}

struct HeaderView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent

    var body: some View {
        HStack(spacing: 10) {
            if !model.routes.isEmpty {
                Button { model.pop() } label: {
                    Image(systemName: "chevron.left").font(.system(size: 13, weight: .semibold))
                }
                .buttonStyle(.plain)
                .keyboardShortcut("[", modifiers: .command)
                .accessibilityLabel("返回")
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(headerTitle)
                    .font(.system(size: 15, weight: .semibold))
                if model.routes.isEmpty {
                    Text(model.remaining == 0 ? "今日已全部完成" : "剩余 \(model.remaining) 项")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .contentTransition(.numericText())
                }
            }
            Spacer()
            if model.isLoading {
                ProgressView().controlSize(.small)
            }
            Button { model.pinned.toggle() } label: {
                Image(systemName: model.pinned ? "pin.fill" : "pin")
                    .font(.system(size: 13))
                    .foregroundStyle(model.pinned ? accent : .secondary)
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.plain)
            .help(model.pinned ? "取消固定（点击外部会收起）" : "固定面板")
            .accessibilityLabel(model.pinned ? "取消固定面板" : "固定面板")

            Menu {
                Button("新建任务", action: model.newTask).disabled(!model.canWrite)
                Button("刷新") { Task { await model.refreshAll() } }
                Button("导出 JSON", action: model.exportJSON).disabled(model.client == nil)
                Divider()
                Button("设置…", action: model.showSettings)
                Button("退出 TodoCue") { NSApp.terminate(nil) }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .frame(width: 24, height: 24)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 28)
            .accessibilityLabel("更多操作")
        }
        .padding(.horizontal, 18)
        .padding(.top, 16)
        .padding(.bottom, 10)
    }

    private var headerTitle: String {
        switch model.routes.last {
        case .detail: return "任务详情"
        case .form(let d): return d.isEditing ? "编辑任务" : "新建任务"
        case .settings: return "设置"
        case nil: return model.todayDateLabel
        }
    }
}

struct OfflineBanner: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: model.connectionState == .connecting ? "arrow.triangle.2.circlepath" : "wifi.slash")
            VStack(alignment: .leading, spacing: 1) {
                Text(model.connectionState == .noRuntime ? "无法连接 TodoCue 运行时" : model.connectionState.label)
                    .font(.system(size: 12, weight: .medium))
                if model.connectionState == .noRuntime {
                    Text("运行 todocue service start 后自动重连")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                } else if model.connectionState != .connecting {
                    Text("显示上次数据，已暂停写入")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button("重试") { model.reconnect() }
                .controlSize(.small)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 8)
        .background(Color.orange.opacity(0.12))
        .accessibilityElement(children: .combine)
    }
}

struct ToastView: View {
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
                Button("撤销") { model.undoComplete(id) }
                    .controlSize(.small)
                    .keyboardShortcut("z", modifiers: .command)
            }
            Button { model.toast = nil } label: {
                Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("关闭提示")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.primary.opacity(0.08), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
        .padding(.horizontal, 16)
        .accessibilityElement(children: .combine)
    }
}
