import SwiftUI
import ServiceManagement
import TodoCueKit

struct SettingsView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
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
                group(L10n.tr("语言"), icon: "globe") {
                    Picker(L10n.tr("界面语言"), selection: $languagePreferences.language) {
                        ForEach(AppLanguage.allCases) { language in
                            Text(language.name).tag(language)
                        }
                    }
                    .pickerStyle(.menu)
                    Text(L10n.tr("语言切换立即生效，任务内容保持原文。"))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                group(L10n.tr("使用习惯"), icon: "cursorarrow.rays") {
                    settingToggle(L10n.tr("登录时启动"), isOn: $loginEnabled)
                        .onChange(of: loginEnabled) { _, on in setLogin(on) }
                    Text(L10n.tr("启动后停留在菜单栏，需要时再展开。"))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    Divider().opacity(0.3)
                    settingToggle(L10n.tr("刘海快览"), isOn: $notchEnabled)
                        .onChange(of: notchEnabled) { _, value in Prefs.isNotchEnabled = value }
                    Text(L10n.tr("鼠标停在刘海上展开今日任务，点一下可固定输入。提醒到来时，Cue 会轻轻弹出，支持完成或稍后提醒。"))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    settingToggle(L10n.tr("收起时显示今日剩余"), isOn: $notchSummary)
                        .onChange(of: notchSummary) { _, value in Prefs.notchShowsSummary = value }
                        .disabled(!notchEnabled)
                    settingToggle(L10n.tr("全屏时保持安静"), isOn: $noFullscreen)
                        .onChange(of: noFullscreen) { _, value in Prefs.disableNotchInFullscreen = value }
                        .disabled(!notchEnabled)
                }
                .toggleStyle(.switch).controlSize(.small)
                group(L10n.tr("快捷键"), icon: "command") {
                    FlowLayout(spacing: 8) {
                        Text(recording ? L10n.tr("按下组合键…") : (hotkey?.displayString ?? L10n.tr("尚未设置")))
                            .font(.system(size: 12, design: .monospaced))
                            .padding(.horizontal, 10).frame(height: 32)
                            .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
                        Button(recording ? L10n.tr("取消") : L10n.tr("录制")) { recording ? stopRecording() : startRecording() }
                            .buttonStyle(CueButtonStyle())
                        Button(L10n.tr("清除")) { hotkey = nil; HotKeyCenter.shared.register(nil) }
                            .buttonStyle(CueButtonStyle()).disabled(hotkey == nil)
                    }
                    Text(L10n.tr("从任何 App 唤出或收起 TodoCue。"))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                group(L10n.tr("提醒通知"), icon: "bell") {
                    row(L10n.tr("授权"), authLabel)
                    FlowLayout {
                        // Once macOS has recorded a denial it will never prompt again, so
                        // asking is a no-op — send the user to the only thing that works.
                        if model.doctor?.notifier.authorization == "denied" {
                            Button(L10n.tr("打开系统设置")) { Task { message = await model.openNotificationSettings() } }
                                .buttonStyle(CueButtonStyle())
                        } else {
                            Button(L10n.tr("请求授权")) { Task { message = await model.requestNotificationAuthorization() } }
                                .buttonStyle(CueButtonStyle())
                        }
                        Button(L10n.tr("测试通知")) { Task { message = await model.sendTestNotification() } }
                            .buttonStyle(CueButtonStyle())
                    }.disabled(!model.canWrite)
                }
                AppleSyncSection(sync: model.appleSync)
                if let message {
                    Text(message).font(.system(size: 12)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true).padding(.horizontal, 6)
                }
                group(L10n.tr("你的数据"), icon: "externaldrive") {
                    Text(L10n.tr("保存在这台 Mac 上"))
                        .font(.system(size: 13, weight: .medium))
                    Text(TodoCueHome.directory.path).font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Text(L10n.tr("移除或重新安装 App，任务仍会保留。"))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    Button(L10n.tr("打开数据文件夹")) { NSWorkspace.shared.open(TodoCueHome.directory) }
                        .buttonStyle(CueButtonStyle())
                }
                DisclosureGroup(L10n.tr("连接与诊断")) {
                    VStack(alignment: .leading, spacing: 12) {
                        row(L10n.tr("状态"), model.connectionState.label)
                        row(L10n.tr("地址"), model.connection?.baseUrl ?? "—")
                        FlowLayout {
                            Button(L10n.tr("重新连接")) { model.reconnect() }.buttonStyle(CueButtonStyle())
                            Button(L10n.tr("重新诊断")) { Task { await model.loadDoctor() } }.buttonStyle(CueButtonStyle())
                        }
                        if let doctor = model.doctor {
                            row(L10n.tr("任务"), L10n.tr("\(doctor.counts.todo) 待办 / \(doctor.counts.tasks) 总计"))
                            row(L10n.tr("提醒"), L10n.tr("\(doctor.counts.pendingReminders) 待发送 / \(doctor.counts.failedReminders) 失败"))
                            row(L10n.tr("时区"), doctor.timezone)
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
                    Text("TodoCue · \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? L10n.tr("开发版"))")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity).padding(.vertical, 10)
            }
            .font(.system(size: 12))
            .padding(.horizontal, 12).padding(.bottom, 12)
        }
        .onAppear { loginEnabled = SMAppService.mainApp.status == .enabled }
        .onDisappear { stopRecording() }
        // The notification switch can only be flipped over in System Settings, so re-read
        // the state when the user comes back — otherwise the panel still says 已拒绝 and
        // the fix looks like it did nothing.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await model.loadDoctor() }
        }
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
        case "authorized": return L10n.tr("已授权")
        case "provisional": return L10n.tr("临时授权")
        case "denied": return L10n.tr("已拒绝（macOS 只询问一次，需在系统设置 › 通知中开启 TodoCueNotifier）")
        case "notDetermined": return L10n.tr("尚未请求")
        case nil: return L10n.tr("未知（点击“诊断”获取）")
        default: return model.doctor?.notifier.authorization ?? L10n.tr("未知")
        }
    }

    private func setLogin(_ on: Bool) {
        guard #available(macOS 13.0, *) else { return }
        do { if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } }
        catch { message = L10n.tr("登录项设置失败：\(error.localizedDescription)"); loginEnabled = !on }
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

/// Two switches that mirror tasks into Apple Calendar and Reminders, which iCloud carries to the phone.
private struct AppleSyncSection: View {
    @ObservedObject var sync: AppleSyncController
    @State private var message: String?
    @State private var pendingRemoval: AppleSyncKind?

    var body: some View {
        EditorSection(title: L10n.tr("Apple 日历与提醒事项"), icon: "calendar") {
            channel(.event, title: L10n.tr("同步到日历"))
            Divider().opacity(0.3)
            channel(.reminder, title: L10n.tr("同步到提醒事项"))
            Text(L10n.tr("有日期的待办会出现在 Apple 日历和提醒事项的「TodoCue」中，经 iCloud 同步到 iPhone。在那边修改、完成或删除，会写回 TodoCue（删除即取消任务）。仅在 TodoCue 运行时同步，不设闹钟。"))
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if sync.isAnyEnabled {
                HStack(spacing: 8) {
                    Text(statusText).font(.system(size: 11))
                        .foregroundStyle(sync.lastError == nil ? Color.secondary : .orange)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Button(L10n.tr("立即同步")) { Task { await sync.syncNow() } }
                        .buttonStyle(CueButtonStyle()).disabled(sync.isSyncing)
                }
            }
            if let message {
                Text(message).font(.system(size: 11)).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .toggleStyle(.switch).controlSize(.small)
        // The panel rarely activates the app, so didBecomeActive cannot be relied on to notice a
        // permission granted in System Settings. Re-read it while this section is on screen.
        .task {
            while !Task.isCancelled {
                sync.refreshAccess()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
        .confirmationDialog(L10n.tr("移除 Apple 中的 TodoCue 数据？"), isPresented: Binding(
            get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } })) {
            Button(L10n.tr("移除"), role: .destructive) {
                guard let kind = pendingRemoval else { return }
                Task { message = await sync.removeData(kind) }
            }
        } message: {
            Text(L10n.tr("将关闭同步，并删除 Apple 侧的「TodoCue」日历或列表。TodoCue 里的任务不受影响。"))
        }
    }

    private var statusText: String {
        if sync.isSyncing { return L10n.tr("正在同步…") }
        if let error = sync.lastError { return L10n.tr("同步出错：\(error)") }
        if let at = sync.lastSyncAt { return L10n.tr("上次同步 \(TCDate.time(at))") }
        return L10n.tr("等待连接运行时后同步")
    }

    @ViewBuilder
    private func channel(_ kind: AppleSyncKind, title: String) -> some View {
        let enabled = sync.isEnabled(kind)
        HStack(spacing: 12) {
            Text(title)
            Spacer(minLength: 8)
            if sync.changing.contains(kind) { ProgressView().controlSize(.mini) }
            Toggle(title, isOn: Binding(get: { sync.isEnabled(kind) }, set: { on in
                Task { message = await sync.setEnabled(kind, on) }
            })).labelsHidden().fixedSize().accessibilityLabel(title)
                .disabled(sync.changing.contains(kind))
        }
        .frame(minHeight: 28)
        if sync.access[kind] == .writeOnly {
            Text(L10n.tr("目前只有写入权限，打开开关可申请完整访问"))
                .font(.system(size: 11)).foregroundStyle(.orange)
        } else if sync.access[kind] == .denied {
            HStack(spacing: 8) {
                Text(L10n.tr("macOS 未允许访问")).font(.system(size: 11)).foregroundStyle(.orange)
                Spacer(minLength: 8)
                Button(L10n.tr("打开系统设置")) { sync.openPrivacySettings(kind) }.buttonStyle(CueButtonStyle())
            }
        } else if enabled, let container = sync.containers[kind] {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(L10n.tr("「\(container.title)」· \(container.sourceTitle)"))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    if !container.isICloud {
                        Text(L10n.tr("不在 iCloud 账户中，不会同步到 iPhone"))
                            .font(.system(size: 11)).foregroundStyle(.orange)
                    }
                }
                Spacer(minLength: 8)
                Button(L10n.tr("移除同步数据")) { pendingRemoval = kind }.buttonStyle(CueButtonStyle())
            }
        }
    }
}
