import SwiftUI
import ServiceManagement
import TodoCueKit

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var notchEnabled = Prefs.isNotchEnabled
    @State private var noFullscreen = Prefs.disableNotchInFullscreen
    @State private var notchSummary = Prefs.notchShowsSummary
    @State private var loginEnabled = false
    @State private var hotkey: HotKeyCombo? = HotKeyCenter.shared.combo
    @State private var recording = false
    @State private var recordMonitor: Any?
    @State private var message: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                group("使用习惯", icon: "cursorarrow.rays") {
                    settingToggle("登录时启动", isOn: $loginEnabled)
                        .onChange(of: loginEnabled) { _, on in setLogin(on) }
                    Text("启动后停留在菜单栏，需要时再展开。")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    Divider().opacity(0.3)
                    settingToggle("刘海快览", isOn: $notchEnabled)
                        .onChange(of: notchEnabled) { _, value in Prefs.isNotchEnabled = value }
                    Text("鼠标停在刘海上展开今日任务，点一下可固定输入。提醒到来时，Cue 会轻轻弹出，支持完成或稍后提醒。")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    settingToggle("收起时显示今日剩余", isOn: $notchSummary)
                        .onChange(of: notchSummary) { _, value in Prefs.notchShowsSummary = value }
                        .disabled(!notchEnabled)
                    settingToggle("全屏时保持安静", isOn: $noFullscreen)
                        .onChange(of: noFullscreen) { _, value in Prefs.disableNotchInFullscreen = value }
                        .disabled(!notchEnabled)
                }
                .toggleStyle(.switch).controlSize(.small)
                group("快捷键", icon: "command") {
                    FlowLayout(spacing: 8) {
                        Text(recording ? "按下组合键…" : (hotkey?.displayString ?? "尚未设置"))
                            .font(.system(size: 12, design: .monospaced))
                            .padding(.horizontal, 10).frame(height: 32)
                            .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
                        Button(recording ? "取消" : "录制") { recording ? stopRecording() : startRecording() }
                            .buttonStyle(CueButtonStyle())
                        Button("清除") { hotkey = nil; HotKeyCenter.shared.register(nil) }
                            .buttonStyle(CueButtonStyle()).disabled(hotkey == nil)
                    }
                    Text("从任何 App 唤出或收起 TodoCue。")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                group("提醒通知", icon: "bell") {
                    row("授权", authLabel)
                    FlowLayout {
                        Button("请求授权") { Task { message = "授权：" + (await model.requestNotificationAuthorization()) } }
                            .buttonStyle(CueButtonStyle())
                        Button("测试通知") { Task { message = await model.sendTestNotification() } }
                            .buttonStyle(CueButtonStyle())
                    }.disabled(!model.canWrite)
                }
                if let message {
                    Text(message).font(.system(size: 12)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true).padding(.horizontal, 6)
                }
                group("你的数据", icon: "externaldrive") {
                    Text("保存在这台 Mac 上")
                        .font(.system(size: 13, weight: .medium))
                    Text(TodoCueHome.directory.path).font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Text("移除或重新安装 App，任务仍会保留。")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    Button("打开数据文件夹") { NSWorkspace.shared.open(TodoCueHome.directory) }
                        .buttonStyle(CueButtonStyle())
                }
                DisclosureGroup("连接与诊断") {
                    VStack(alignment: .leading, spacing: 12) {
                        row("状态", model.connectionState.label)
                        row("地址", model.connection?.baseUrl ?? "—")
                        FlowLayout {
                            Button("重新连接") { model.reconnect() }.buttonStyle(CueButtonStyle())
                            Button("重新诊断") { Task { await model.loadDoctor() } }.buttonStyle(CueButtonStyle())
                        }
                        if let doctor = model.doctor {
                            row("任务", "\(doctor.counts.todo) 待办 / \(doctor.counts.tasks) 总计")
                            row("提醒", "\(doctor.counts.pendingReminders) 待发送 / \(doctor.counts.failedReminders) 失败")
                            row("时区", doctor.timezone)
                            ForEach(doctor.checks, id: \.name) { check in
                                Label(check.name + "：" + check.detail, systemImage: check.ok ? "checkmark.circle" : "exclamationmark.circle")
                                    .font(.system(size: 11)).foregroundStyle(check.ok ? Color.secondary : .orange)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }.padding(.top, 14)
                }
                .font(.system(size: 12, weight: .medium)).padding(16).cueSurface()
                HStack(spacing: 6) {
                    CueMark().scaleEffect(0.7).frame(width: 14, height: 14)
                    Text("TodoCue · \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "开发版")")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity).padding(.vertical, 10)
            }
            .font(.system(size: 12))
            .padding(.horizontal, 12).padding(.bottom, 12)
        }
        .onAppear { loginEnabled = SMAppService.mainApp.status == .enabled }
        .onDisappear { stopRecording() }
    }

    private func settingToggle(_ title: String, isOn: Binding<Bool>) -> some View {
        HStack(spacing: 12) {
            Text(title).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Toggle(title, isOn: isOn).labelsHidden().fixedSize().accessibilityLabel(title)
        }
        .frame(minHeight: 28)
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

    private func group<Content: View>(_ title: String, icon: String, @ViewBuilder _ content: () -> Content) -> some View {
        EditorSection(title: title, icon: icon, content: content)
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(k).foregroundStyle(.secondary).frame(width: 56, alignment: .leading)
            Text(v).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}
