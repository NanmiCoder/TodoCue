import SwiftUI
import TodoCueKit

struct PeriodicRemindersView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @State private var busy: Set<String> = []

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Text(L10n.tr("给日常留一点提醒")).font(.system(size: 12)).foregroundStyle(.secondary)
                Spacer()
                Button(action: model.newPeriodic) { Label(L10n.tr("新建"), systemImage: "plus") }
                    .disabled(!model.canWrite).accessibilityIdentifier("periodic.new")
            }
            if let error = model.periodicLoadError {
                VStack(alignment: .leading, spacing: 6) {
                    Text(error).font(.caption).foregroundStyle(.orange)
                    Button(L10n.tr("重试")) { Task { await model.refreshPeriodic() } }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            ScrollViewReader { proxy in
              ScrollView {
                VStack(spacing: 10) {
                    if model.periodicReminders.isEmpty && model.periodicLoadError == nil {
                        VStack(spacing: 12) {
                            Image(systemName: "timer").font(.system(size: 30)).foregroundStyle(Dial.orange)
                            Text(L10n.tr("喝水、活动，按你的节奏提醒")).font(.system(size: 14))
                            Button(L10n.tr("创建第一个提醒"), action: model.newPeriodic).disabled(!model.canWrite)
                        }.padding(.vertical, 40)
                    }
                    ForEach(model.periodicReminders) { rule in row(rule).id(rule.id) }
                }.padding(.vertical, 4)
              }
              .onChange(of: model.periodicReminders) { _, _ in
                  if let id = model.periodicSelectedId { proxy.scrollTo(id, anchor: .center) }
              }
              .onChange(of: model.periodicSelectedId) { _, id in
                  if let id { proxy.scrollTo(id, anchor: .center) }
              }
              .task {
                  await Task.yield()
                  if let id = model.periodicSelectedId { proxy.scrollTo(id, anchor: .center) }
              }
            }
        }.padding(14).task { await model.refreshPeriodic() }
    }
    private func row(_ rule: PeriodicReminder) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top) {
                Text(rule.title).font(.system(size: 15, weight: .semibold)).frame(maxWidth: .infinity, alignment: .leading)
                Toggle(L10n.tr("启用"), isOn: Binding(get: { rule.enabled }, set: { active in act(rule, active ? "resume" : "pause") }))
                    .labelsHidden().toggleStyle(.switch).controlSize(.mini)
                    .accessibilityLabel(L10n.tr("启用周期提醒 \(rule.title)"))
            }
            Text(rule.configuration.localizedSummary).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Text(rule.stateLabel).font(.system(size: 12, weight: .medium)).foregroundStyle(rule.state == "waiting" ? Dial.orange : .secondary)
                Spacer(minLength: 4)
                if rule.state == "waiting", let current = rule.currentOccurrence, ["displayed", "submitted"].contains(current.delivery) {
                    Button(L10n.tr("完成本次")) { act(rule, "complete") }.controlSize(.small)
                }
                Menu {
                    Button(L10n.tr("今天暂停")) { act(rule, "pause_today") }
                    if rule.state == "paused_today" { Button(L10n.tr("恢复提醒")) { act(rule, "resume") } }
                    Button(L10n.tr("编辑")) { model.editPeriodic(rule) }
                    Divider()
                    Button(L10n.tr("删除"), role: .destructive) { act(rule, "delete") }
                } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).frame(width: 24)
                .accessibilityLabel(L10n.tr("管理周期提醒 \(rule.title)"))
                if busy.contains(rule.id) { ProgressView().controlSize(.mini) }
            }
            if let current = rule.currentOccurrence, current.delivery == "failed", let error = current.lastError {
                Text(error).font(.caption).foregroundStyle(.orange)
            }
        }.padding(13).cueSurface(radius: 16)
            .overlay { RoundedRectangle(cornerRadius: 16).stroke(Dial.orange.opacity(model.periodicSelectedId == rule.id ? 0.6 : 0), lineWidth: 1) }
            .disabled(!model.canWrite || busy.contains(rule.id))
    }
    private func act(_ rule: PeriodicReminder, _ action: String) {
        guard busy.insert(rule.id).inserted else { return }
        Task { _ = await model.actOnPeriodic(rule, action: action); busy.remove(rule.id) }
    }
}

struct PeriodicReminderForm: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @Binding var draft: PeriodicDraft
    @State private var daysOpen = false
    @State private var intervalOpen = false
    @State private var windowsOpen = false
    @State private var advancedOpen = false
    @State private var saving = false
    @State private var preview: APIClient.PeriodicPreview?
    @State private var previewError: String?
    @State private var saveError: String?
    @State private var versionConflict = false
    @FocusState private var titleFocused: Bool

    var body: some View {
        VStack(spacing: 12) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    templates
                    VStack(alignment: .leading, spacing: 12) {
                        TextField(L10n.tr("提醒什么？"), text: $draft.title, axis: .vertical)
                            .font(.system(size: 19, weight: .semibold)).textFieldStyle(.plain).focused($titleFocused)
                            .accessibilityIdentifier("periodic.title")
                        fieldError("title")
                        FlowLayout(spacing: 7, rowSpacing: 7) {
                            chip(L10n.tr("每 \(draft.interval) 分钟"), icon: "timer") { intervalOpen.toggle() }
                                .popover(isPresented: $intervalOpen) { intervalPicker.padding(14).frame(width: 230) }
                            chip(draft.configuration.daysLabel, icon: "repeat") { daysOpen.toggle() }
                                .popover(isPresented: $daysOpen) { dayPicker.padding(14).frame(width: 270) }
                            chip(draft.windows.map { "\($0.start)–\($0.end)" }.joined(separator: "、"), icon: "clock") { windowsOpen.toggle() }
                        }
                        fieldError("interval")
                        fieldError("weekdays")
                        if windowsOpen { windowPicker }
                        fieldError("windows")
                        Divider().opacity(0.4)
                        if let preview {
                            Text(PeriodicReminder.nextLabel(preview.nextFireAt, timezone: preview.config.timezone))
                                .font(.system(size: 12, weight: .medium)).foregroundStyle(Dial.orange)
                        } else if let previewError {
                            Text(previewError).font(.caption).foregroundStyle(.orange)
                        } else if draft.errors.isEmpty { Text(L10n.tr("正在计算下一次提醒…")).font(.caption).foregroundStyle(.secondary) }
                        DisclosureGroup(L10n.tr("更多设置"), isExpanded: $advancedOpen) {
                            VStack(alignment: .leading, spacing: 10) {
                                Picker(L10n.tr("计时方式"), selection: $draft.mode) {
                                    ForEach(PeriodicMode.allCases, id: \.self) { mode in Text(mode.label).tag(mode) }
                                }.pickerStyle(.menu)
                                Text(draft.mode == .fixed ? L10n.tr("按时段起点提醒，完成不会改变后续时间。")
                                     : L10n.tr("确认完成后才计时；未确认则等待，下个生效日重新开始。"))
                                    .font(.caption).foregroundStyle(.secondary)
                                TextField(L10n.tr("时区"), text: Binding(get: { draft.timezone }, set: {
                                    draft.timezone = $0; draft.usesRuntimeTimezone = false
                                })).textFieldStyle(.roundedBorder)
                                fieldError("timezone")
                            }.padding(.top, 8)
                        }.font(.system(size: 12))
                    }.padding(16).cueSurface(radius: 20)
                    if let saveError { Text(saveError).font(.caption).foregroundStyle(.orange) }
                    if versionConflict {
                        Button(L10n.tr("重新载入最新规则（替换当前草稿）")) { reload() }.disabled(saving)
                    }
                }.padding(.horizontal, 12).padding(.bottom, 12)
            }.disabled(saving)
            HStack {
                Button(L10n.tr("返回")) { model.pop() }.disabled(saving)
                Spacer()
                if saving { ProgressView().controlSize(.small) }
                Button(draft.editingId == nil ? L10n.tr("创建") : L10n.tr("保存")) { save() }
                    .buttonStyle(CueButtonStyle(prominent: true)).keyboardShortcut(.return, modifiers: .command)
                    .disabled(saving || !model.canWrite || !draft.errors.isEmpty)
                    .accessibilityIdentifier("periodic.save")
            }.padding(.horizontal, 14).padding(.bottom, 12)
        }
        .onChange(of: draft) { _, _ in saveError = nil }
        .task(id: draft) { await updatePreview() }
    }
    private var templates: some View {
        HStack(spacing: 8) {
            Button(L10n.tr("活动")) { draft.chooseTemplate(L10n.tr("起来活动一下")) }
            Button(L10n.tr("喝水")) { draft.chooseTemplate(L10n.tr("喝点水")) }
            Button(L10n.tr("自定义")) { draft.chooseTemplate(""); titleFocused = true }
        }.buttonStyle(.bordered).controlSize(.small)
    }
    private func chip(_ text: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Label(text.isEmpty ? L10n.tr("选择") : text, systemImage: icon).font(.system(size: 12)).lineLimit(2) }
            .buttonStyle(.bordered).controlSize(.small)
    }
    @ViewBuilder private func fieldError(_ field: String) -> some View {
        if let text = draft.errors[field] { Text(text).font(.caption).foregroundStyle(.orange) }
    }
    private var intervalPicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                ForEach([15, 30, 60], id: \.self) { minutes in
                    Button("\(minutes)") { draft.interval = String(minutes); intervalOpen = false }
                }
            }
            HStack { TextField(L10n.tr("自定义分钟"), text: $draft.interval).textFieldStyle(.roundedBorder); Text(L10n.tr("分钟")) }
            fieldError("interval")
        }
    }
    private var dayPicker: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 5) {
                ForEach(1...7, id: \.self) { day in
                    Button {
                        if draft.weekdays.contains(day) { draft.weekdays.remove(day) } else { draft.weekdays.insert(day) }
                    } label: {
                        Text(PeriodicConfiguration.dayLabel(day)).font(.system(size: 11, weight: .medium))
                            .frame(width: 27, height: 28)
                            .background(draft.weekdays.contains(day) ? Dial.orange.opacity(0.22) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 7))
                    }.buttonStyle(.plain).accessibilityAddTraits(draft.weekdays.contains(day) ? .isSelected : [])
                }
            }
            HStack {
                Button(L10n.tr("每天")) { draft.weekdays = Set(1...7) }
                Button(L10n.tr("周一至周五")) { draft.weekdays = Set(1...5) }
                Button(L10n.tr("周末")) { draft.weekdays = [6, 7] }
            }.controlSize(.small)
            fieldError("weekdays")
        }
    }
    private var windowPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(draft.windows.indices, id: \.self) { index in
                HStack(spacing: 6) {
                    TextField("09:00", text: $draft.windows[index].start).textFieldStyle(.roundedBorder).accessibilityLabel(L10n.tr("开始时间"))
                    Text("–").foregroundStyle(.secondary)
                    TextField("18:00", text: $draft.windows[index].end).textFieldStyle(.roundedBorder).accessibilityLabel(L10n.tr("结束时间"))
                    if draft.windows.count > 1 {
                        Button { draft.windows.remove(at: index) } label: { Image(systemName: "minus.circle") }
                            .buttonStyle(.plain).accessibilityLabel(L10n.tr("移除时段"))
                    }
                }
            }
            Button(L10n.tr("添加时段")) {
                let start = draft.windows.last?.end ?? "09:00"
                let components = start.split(separator: ":").compactMap { Int($0) }
                let minute = components.count == 2 ? components[0] * 60 + components[1] : 540
                let end = min(1440, minute + 180)
                let endText = String(format: "%02d:%02d", end / 60, end % 60)
                draft.windows.append(.init(start: start == "24:00" ? "09:00" : start, end: start == "24:00" ? "12:00" : endText))
            }.disabled(draft.windows.count >= 24)
        }
    }
    private func updatePreview() async {
        preview = nil; previewError = nil
        let snapshot = draft
        guard snapshot.errors.isEmpty, let client = model.client else { return }
        do {
            try await Task.sleep(nanoseconds: 250_000_000)
            let result = try await client.previewPeriodic(snapshot.createFields)
            guard !Task.isCancelled, snapshot == draft else { return }
            preview = result
            if draft.usesRuntimeTimezone && draft.timezone != result.config.timezone { draft.timezone = result.config.timezone }
        } catch {
            guard !Task.isCancelled, snapshot == draft else { return }
            previewError = error.localizedDescription
        }
    }
    private func save() {
        guard !saving, draft.errors.isEmpty else { return }
        saving = true; saveError = nil
        let snapshot = draft
        Task {
            do { _ = try await model.savePeriodic(snapshot) }
            catch let error as APIError where error.isVersionConflict {
                versionConflict = true
                saveError = L10n.tr("规则已在别处修改。当前输入已保留，可重新载入最新规则。")
            }
            catch { saveError = error.localizedDescription }
            saving = false
        }
    }
    private func reload() {
        guard !saving, let id = draft.editingId, let client = model.client else { return }
        saving = true
        Task {
            defer { saving = false }
            do {
                let rule = try await client.periodicReminder(id)
                var replacement = PeriodicDraft(editing: rule)
                replacement.saveKey = draft.saveKey
                draft = replacement
                saveError = nil; versionConflict = false
            } catch { saveError = error.localizedDescription }
        }
    }
}
