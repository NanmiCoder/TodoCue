import SwiftUI
import ServiceManagement
import TodoCueKit

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var notchEnabled = Prefs.isNotchEnabled
    @State private var noFullscreen = Prefs.disableNotchInFullscreen
    @State private var loginEnabled = false
    @State private var hotkey: HotKeyCombo? = HotKeyCenter.shared.combo
    @State private var recording = false
    @State private var recordMonitor: Any?
    @State private var message: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                group("连接") {
                    row("状态", model.connectionState.label)
                    row("地址", model.connection?.baseUrl ?? "—")
                    row("运行时", model.connection?.runtimeVersion ?? "—")
                    HStack { Button("重新连接") { model.reconnect() }; Button("诊断") { Task { await model.loadDoctor() } } }.controlSize(.small)
                }
                group("通知") {
                    row("授权", authLabel)
                    if let n = model.doctor?.notifier {
                        row("辅助程序", n.available ? (n.path ?? "可用") : "未安装 · 使用降级通道")
                    }
                    HStack {
                        Button("请求授权") { Task { message = "授权：" + (await model.requestNotificationAuthorization()) } }
                        Button("发送测试通知") { Task { message = await model.sendTestNotification() } }
                    }
                    .controlSize(.small)
                    .disabled(!model.canWrite)
                    if let message { Text(message).font(.system(size: 11)).foregroundStyle(.secondary) }
                }
                group("快捷键") {
                    HStack {
                        Text(recording ? "按下组合键…" : (hotkey?.displayString ?? "未绑定"))
                            .font(.system(size: 12, design: .monospaced))
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
                        Button(recording ? "取消" : "录制") { recording ? stopRecording() : startRecording() }
                        Button("清除") { hotkey = nil; HotKeyCenter.shared.register(nil) }.disabled(hotkey == nil)
                    }
                    .controlSize(.small)
                    Text("全局快捷键用于切换面板，默认不绑定。").font(.system(size: 11)).foregroundStyle(.secondary)
                }
                group("行为") {
                    Toggle("登录时启动（只进入菜单栏）", isOn: $loginEnabled)
                        .onChange(of: loginEnabled) { _, on in setLogin(on) }
                    Toggle("启用刘海快览", isOn: $notchEnabled)
                        .onChange(of: notchEnabled) { _, v in Prefs.isNotchEnabled = v }
                    Toggle("全屏应用中不自动展开", isOn: $noFullscreen)
                        .onChange(of: noFullscreen) { _, v in Prefs.disableNotchInFullscreen = v }
                        .disabled(!notchEnabled)
                }
                if let d = model.doctor {
                    group("诊断") {
                        row("数据库", d.databasePath)
                        row("时区", d.timezone)
                        row("任务", "\(d.counts.todo) 待办 / \(d.counts.tasks) 总计 / \(d.counts.series) 系列")
                        row("提醒", "\(d.counts.pendingReminders) 待发送 / \(d.counts.failedReminders) 失败")
                        ForEach(d.checks, id: \.name) { c in
                            Label(c.name + "：" + c.detail, systemImage: c.ok ? "checkmark.circle" : (c.level == "warn" ? "exclamationmark.triangle" : "xmark.octagon"))
                                .foregroundStyle(c.ok ? Color.secondary : (c.level == "warn" ? .orange : .red))
                        }
                    }
                }
            }
            .font(.system(size: 12))
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
        }
        .onAppear {
            if #available(macOS 13.0, *) { loginEnabled = SMAppService.mainApp.status == .enabled }
        }
        .onDisappear { stopRecording() }
    }

    private var authLabel: String {
        switch model.doctor?.notifier.authorization {
        case "authorized": return "已授权"
        case "provisional": return "临时授权"
        case "denied": return "已拒绝（在系统设置 › 通知中开启 TodoCueNotifier）"
        case "notDetermined": return "尚未请求"
        case nil: return "未知（点击“诊断”获取）"
        default: return model.doctor?.notifier.authorization ?? "未知"
        }
    }

    private func setLogin(_ on: Bool) {
        guard #available(macOS 13.0, *) else { return }
        do { if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } }
        catch { message = "登录项设置失败：\(error.localizedDescription)"; loginEnabled = !on }
    }

    private func startRecording() {
        recording = true
        recordMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            let flags = e.modifierFlags.intersection([.command, .option, .control, .shift])
            if e.keyCode == 53 { stopRecording(); return nil }
            guard !flags.isEmpty else { return nil }
            let c = HotKeyCombo(keyCode: UInt32(e.keyCode), modifiers: UInt32(flags.rawValue))
            hotkey = c
            HotKeyCenter.shared.register(c)
            stopRecording()
            return nil
        }
    }

    private func stopRecording() {
        recording = false
        if let m = recordMonitor { NSEvent.removeMonitor(m); recordMonitor = nil }
    }

    private func group<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary).accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(k).foregroundStyle(.secondary).frame(width: 56, alignment: .leading)
            Text(v).textSelection(.enabled).lineLimit(3)
        }
        .accessibilityElement(children: .combine)
    }
}
