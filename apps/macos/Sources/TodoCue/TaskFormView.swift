import SwiftUI
import AppKit
import UniformTypeIdentifiers
import TodoCueKit

struct TaskFormView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    @State var draft: TaskDraft
    @State private var error: String?
    @State private var saving = false
    @State private var versionConflict = false
    @State private var importingAttachments = false
    @FocusState private var titleFocused: Bool

    // Popover & Sheet states
    @State private var showSchedulePopover = false
    @State private var showProjectPopover = false
    @State private var showEstimatePopover = false
    @State private var showRepeatPopover = false
    @State private var choosingFiles = false
    @State private var attachmentError: String?
    @State private var isTargetedForDrop = false

    init(draft: TaskDraft) {
        _draft = State(initialValue: draft)
    }

    private var keptAttachments: [TaskAttachment] {
        draft.existingAttachments.filter { !draft.removedAttachmentIds.contains($0.id) }
    }

    private var totalAttachmentCount: Int {
        keptAttachments.count + draft.pendingAttachments.count
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    // Unified Composer Canvas
                    VStack(alignment: .leading, spacing: 12) {
                        // Title Input
                        TextField(L10n.tr("准备做什么？"), text: $draft.title, axis: .vertical)
                            .lineLimit(2...4)
                            .font(.system(size: 19, weight: .semibold, design: .rounded))
                            .textFieldStyle(.plain)
                            .focused($titleFocused)
                            .accessibilityLabel(L10n.tr("标题"))

                        // Notes Input
                        TextField(L10n.tr("添加备注、链接或详细想法..."), text: $draft.notes, axis: .vertical)
                            .lineLimit(2...6)
                            .font(.system(size: 13))
                            .textFieldStyle(.plain)
                            .accessibilityLabel(L10n.tr("备注"))

                        Divider().opacity(0.35).padding(.vertical, 2)

                        // Interactive Attribute Chip Bar
                        FlowLayout(spacing: 7, rowSpacing: 7) {
                            if draft.repeatKind == .none { scheduleChip }
                            projectChip
                            priorityChip
                            estimateChip
                            repeatChip
                            attachmentChip
                        }

                        // Attachments Gallery (Only shown if attachments are present)
                        if totalAttachmentCount > 0 {
                            Divider().opacity(0.35).padding(.vertical, 2)
                            attachmentDrawer
                        }
                        if let attachmentError {
                            Text(attachmentError)
                                .font(.system(size: 11))
                                .foregroundStyle(.red)
                        }
                        if draft.repeatKind != .none {
                            Text(L10n.tr("附件仅保存到首次任务。"))
                                .font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                    }
                    .padding(16)
                    .cueSurface(radius: 20)
                    .overlay {
                        if isTargetedForDrop {
                            RoundedRectangle(cornerRadius: 20, style: .continuous)
                                .strokeBorder(accent, lineWidth: 2)
                                .background(accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        }
                    }
                    .onDrop(of: [.fileURL], isTargeted: $isTargetedForDrop) { providers in
                        handleDrop(providers: providers)
                    }

                    if draft.isSeriesInstance {
                        Label(L10n.tr("重复任务 · 修改只影响本次"), systemImage: "repeat")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
            }
            .disabled(saving)

            bottomBar
        }
        .task {
            await Task.yield()
            titleFocused = true
        }
        .defaultFocus($titleFocused, true)
        .fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): addAttachments(urls)
            case .failure(let err): attachmentError = err.localizedDescription
            }
        }
        .onChange(of: draft) { old, new in
            if error != nil && error == old.validate() { error = new.validate() }
            model.updateFormDraft(new)
        }
    }

    // MARK: - Attribute Chips

    private var hasSchedule: Bool {
        draft.scheduledMode != .none || draft.dueMode != .none || draft.reminderOn
    }

    private var scheduleChip: some View {
        AttributeChip(isActive: hasSchedule, onClear: hasSchedule ? {
            draft.scheduledMode = .none
            draft.dueMode = .none
            draft.reminderOn = false
        } : nil) {
            Button { showSchedulePopover.toggle() } label: {
                AttributeChipLabel(title: scheduleChipTitle, icon: "calendar", isActive: hasSchedule)
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showSchedulePopover, arrowEdge: .bottom) {
                SchedulePopoverView(draft: $draft, close: { showSchedulePopover = false })
            }
        }
        .help(L10n.tr("计划、截止与提醒"))
    }

    private var scheduleChipTitle: String {
        if draft.scheduledMode != .none {
            let label = TCDate.dateLabel(TCDate.localDateString(draft.scheduledDate))
            if draft.scheduledMode == .dateTime { return label + " " + TCDate.time(draft.scheduledDate) }
            return label
        }
        if draft.dueMode != .none { return L10n.tr("截止 ") + TCDate.dateLabel(TCDate.localDateString(draft.dueDate)) }
        if draft.reminderOn { return L10n.tr("提醒 ") + TCDate.time(draft.reminderDate) }
        return L10n.tr("日期")
    }

    private var projectChip: some View {
        AttributeChip(isActive: !draft.project.isEmpty, onClear: !draft.project.isEmpty ? { draft.project = "" } : nil) {
            Button { showProjectPopover.toggle() } label: {
                AttributeChipLabel(title: draft.project.isEmpty ? L10n.tr("项目") : draft.project, icon: "folder", isActive: !draft.project.isEmpty)
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showProjectPopover, arrowEdge: .bottom) {
                ProjectPopoverView(project: $draft.project, existingProjects: model.projects, close: { showProjectPopover = false })
            }
        }
    }

    private var priorityChip: some View {
        AttributeChip(isActive: draft.priority != .none, tint: draft.priority.color,
                      onClear: draft.priority != .none ? { draft.priority = .none } : nil) {
            Menu {
                Button(L10n.tr("无")) { draft.priority = .none }
                Button(L10n.tr("低")) { draft.priority = .low }
                Button(L10n.tr("中")) { draft.priority = .medium }
                Button(L10n.tr("高")) { draft.priority = .high }
            } label: {
                AttributeChipLabel(title: draft.priority == .none ? L10n.tr("优先级") : draft.priority.label,
                                   icon: draft.priority.symbol ?? "flag", isActive: draft.priority != .none, tint: draft.priority.color)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden)
        }
    }

    private var estimateChip: some View {
        AttributeChip(isActive: !draft.estimate.isEmpty, onClear: !draft.estimate.isEmpty ? { draft.estimate = "" } : nil) {
            Button { showEstimatePopover.toggle() } label: {
                AttributeChipLabel(title: draft.estimate.isEmpty ? L10n.tr("预估") : "\(draft.estimate)m", icon: "timer", isActive: !draft.estimate.isEmpty)
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showEstimatePopover, arrowEdge: .bottom) {
                EstimatePopoverView(estimate: $draft.estimate, close: { showEstimatePopover = false })
            }
        }
    }

    private var repeatChip: some View {
        AttributeChip(isActive: draft.repeatKind != .none, onClear: draft.repeatKind != .none ? { draft.repeatKind = .none } : nil) {
            Button { showRepeatPopover.toggle() } label: {
                AttributeChipLabel(title: draft.repeatKind == .none ? L10n.tr("重复") : draft.repeatKind.label, icon: "repeat", isActive: draft.repeatKind != .none)
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showRepeatPopover, arrowEdge: .bottom) {
                RepeatPopoverView(draft: $draft, close: { showRepeatPopover = false })
            }
        }
        .disabled(draft.isEditing)
    }

    private var attachmentChip: some View {
        AttributeChip(isActive: totalAttachmentCount > 0) {
            Menu {
                Button(L10n.tr("添加附件")) { choosingFiles = true }
                Button(L10n.tr("粘贴图片"), action: pasteImage)
            } label: {
                AttributeChipLabel(title: totalAttachmentCount > 0 ? "\(totalAttachmentCount)" : L10n.tr("附件"), icon: "paperclip", isActive: totalAttachmentCount > 0)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden)
        }
        .disabled(importingAttachments)
    }

    // MARK: - Attachment Drawer

    @ViewBuilder
    private var attachmentDrawer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(L10n.tr("图片与附件"), systemImage: "paperclip")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer()
                Text("\(totalAttachmentCount) / 20")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
            if !keptAttachments.isEmpty {
                AttachmentGallery(attachments: keptAttachments, onRemove: { draft.removedAttachmentIds.insert($0.id) })
            }
            if !draft.pendingAttachments.isEmpty {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 2), spacing: 8) {
                    ForEach(draft.pendingAttachments) { item in
                        PendingAttachmentTile(item: item) {
                            draft.pendingAttachments.removeAll { $0.id == item.id }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Bottom Bar

    private var bottomBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let error {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.system(size: 12))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if versionConflict {
                Button(L10n.tr("重新载入最新任务（替换当前草稿）"), action: reload)
                    .controlSize(.small)
                    .disabled(saving || importingAttachments || !model.canWrite)
            }
            HStack(spacing: 8) {
                Text(model.canWrite ? L10n.tr("返回会保留草稿") : L10n.tr("离线，草稿已保留"))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                if saving || importingAttachments {
                    ProgressView().controlSize(.small)
                }
                HStack(spacing: 2) {
                    Text("⌘↵").font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(.tertiary)
                }
                Button(draft.isEditing ? L10n.tr("保存更改") : L10n.tr("添加任务"), action: save)
                    .buttonStyle(CueButtonStyle(prominent: true))
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(saving || importingAttachments || versionConflict || !model.canWrite)
                    .help(L10n.tr("⌘Return 保存"))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    // MARK: - Actions

    private func save() {
        guard !saving, !importingAttachments else { return }
        error = draft.validate()
        guard error == nil else { return }
        saving = true
        let submitted = draft
        Task {
            defer { saving = false }
            do {
                try await model.save(submitted)
            } catch let err as APIError where err.isVersionConflict {
                versionConflict = true
                error = L10n.tr("任务已在别处修改。当前草稿已保留，请复制需要的内容后重新载入最新任务。")
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func reload() {
        guard !saving, !importingAttachments else { return }
        saving = true
        Task {
            defer { saving = false }
            do { try await model.reloadForm(draft) }
            catch { self.error = error.localizedDescription }
        }
    }

    private func addAttachments(_ urls: [URL]) {
        guard !saving, !importingAttachments else { return }
        attachmentError = nil
        importingAttachments = true
        Task { @MainActor in
            defer { importingAttachments = false }
            await importAttachments(urls)
        }
    }

    @MainActor private func importAttachments(_ urls: [URL]) async {
        do {
            guard totalAttachmentCount + urls.count <= AttachmentLimits.count else {
                throw APIError.transport(L10n.tr("每个任务最多 20 个附件"))
            }
            var items: [PendingAttachment] = []
            var bytes = keptAttachments.reduce(0) { $0 + $1.size } + draft.pendingAttachments.reduce(0) { $0 + $1.data.count }
            for url in urls {
                let item = try await PendingAttachment.read(url)
                bytes += item.data.count
                guard bytes <= AttachmentLimits.totalBytes else {
                    throw APIError.transport(L10n.tr("附件总大小不能超过 30 MB"))
                }
                items.append(item)
            }
            try draft.addAttachments(items)
            model.updateFormDraft(draft)
        } catch { attachmentError = error.localizedDescription }
    }

    private func pasteImage() {
        guard !saving, !importingAttachments else { return }
        guard let image = NSImage(pasteboard: .general), let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff), let data = rep.representation(using: .png, properties: [:]) else {
            attachmentError = L10n.tr("剪贴板里还没有图片")
            return
        }
        guard data.count <= AttachmentLimits.fileBytes else {
            attachmentError = L10n.tr("图片超过 10 MB，请缩小后再添加")
            return
        }
        guard keptAttachments.count + draft.pendingAttachments.count < AttachmentLimits.count,
              keptAttachments.reduce(0, { $0 + $1.size }) + draft.pendingAttachments.reduce(0, { $0 + $1.data.count }) + data.count <= AttachmentLimits.totalBytes else {
            attachmentError = L10n.tr("最多 20 个附件，总计 30 MB")
            return
        }
        attachmentError = nil
        draft.pendingAttachments.append(PendingAttachment(name: L10n.tr("粘贴图片-\(draft.pendingAttachments.count + 1).png"), mediaType: "image/png", data: data))
    }

    private func handleDrop(providers: [NSItemProvider]) -> Bool {
        let files = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
        guard !files.isEmpty, !saving, !importingAttachments else { return false }
        importingAttachments = true
        attachmentError = nil
        Task { @MainActor in
            defer { importingAttachments = false }
            do {
                var urls: [URL] = []
                for provider in files {
                    let url: URL = try await withCheckedThrowingContinuation { continuation in
                        provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, error in
                            if let error { continuation.resume(throwing: error) }
                            else if let url = item as? URL { continuation.resume(returning: url) }
                            else if let data = item as? Data, let url = URL(dataRepresentation: data, relativeTo: nil) {
                                continuation.resume(returning: url)
                            } else { continuation.resume(throwing: APIError.transport(L10n.tr("无法读取拖入的文件"))) }
                        }
                    }
                    urls.append(url)
                }
                await importAttachments(urls)
            } catch { attachmentError = error.localizedDescription }
        }
        return true
    }
}

// MARK: - Popover Views

struct SchedulePopoverView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @Binding var draft: TaskDraft
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Quick Presets
            HStack(spacing: 6) {
                Button(L10n.tr("今天")) {
                    draft.scheduledMode = .date
                    draft.scheduledDate = TaskDraft.defaultDate()
                    close()
                }
                .buttonStyle(CueButtonStyle())
                Button(L10n.tr("明天")) {
                    draft.scheduledMode = .date
                    draft.scheduledDate = Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
                    close()
                }
                .buttonStyle(CueButtonStyle())
                Spacer()
                if draft.scheduledMode != .none {
                    Button(L10n.tr("清除")) {
                        draft.scheduledMode = .none
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                }
            }

            Divider().opacity(0.4)

            // Scheduled Mode & Graphical Calendar
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(L10n.tr("计划"))
                        .font(.system(size: 12, weight: .medium))
                    Spacer()
                    Picker("", selection: $draft.scheduledMode) {
                        ForEach(DateMode.allCases) { Text($0.label).tag($0) }
                    }
                    .labelsHidden()
                    .frame(width: 110)
                }
                if draft.scheduledMode != .none {
                    DatePicker("", selection: $draft.scheduledDate, displayedComponents: draft.scheduledMode == .dateTime ? [.date, .hourAndMinute] : [.date])
                        .labelsHidden()
                        .datePickerStyle(.graphical)
                }
            }

            Divider().opacity(0.4)

            // Due Date
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(L10n.tr("截止"))
                        .font(.system(size: 12, weight: .medium))
                    Spacer()
                    Picker("", selection: $draft.dueMode) {
                        ForEach(DateMode.allCases) { Text($0.label).tag($0) }
                    }
                    .labelsHidden()
                    .frame(width: 110)
                }
                if draft.dueMode != .none {
                    DatePicker("", selection: $draft.dueDate, displayedComponents: draft.dueMode == .dateTime ? [.date, .hourAndMinute] : [.date])
                        .labelsHidden()
                        .datePickerStyle(.compact)
                }
            }

            // Reminder
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(L10n.tr("提醒"))
                        .font(.system(size: 12, weight: .medium))
                    Spacer()
                    Toggle("", isOn: $draft.reminderOn)
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .controlSize(.mini)
                }
                if draft.reminderOn {
                    DatePicker("", selection: $draft.reminderDate, displayedComponents: [.date, .hourAndMinute])
                        .labelsHidden()
                        .datePickerStyle(.compact)
                }
            }

            HStack {
                Spacer()
                Button(L10n.tr("完成"), action: close)
                    .buttonStyle(CueButtonStyle(prominent: true))
                    .controlSize(.small)
            }
        }
        .padding(14)
        .frame(width: 280)
        .todoCueAccent()
    }
}

struct ProjectPopoverView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @Binding var project: String
    let existingProjects: [String]
    let close: () -> Void
    @State private var input = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField(L10n.tr("项目名称"), text: $input)
                    .textFieldStyle(.plain)
                    .onSubmit {
                        if !input.trimmingCharacters(in: .whitespaces).isEmpty {
                            project = input.trimmingCharacters(in: .whitespaces)
                            close()
                        }
                    }
                if !input.isEmpty {
                    Button { input = "" } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain)
                }
            }
            .padding(7)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))

            if !input.isEmpty && !existingProjects.contains(input) {
                Button {
                    project = input.trimmingCharacters(in: .whitespaces)
                    close()
                } label: {
                    HStack {
                        Image(systemName: "plus.circle")
                        Text(L10n.tr("选择") + "「\(input)」")
                    }
                    .font(.system(size: 12))
                }
                .buttonStyle(.plain)
            }

            if !existingProjects.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(existingProjects.filter { input.isEmpty || $0.localizedCaseInsensitiveContains(input) }, id: \.self) { p in
                            Button {
                                project = p
                                close()
                            } label: {
                                HStack {
                                    Text(p)
                                    Spacer()
                                    if project == p {
                                        Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                                    }
                                }
                                .padding(.vertical, 5).padding(.horizontal, 6)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(maxHeight: 160)
            }

            if !project.isEmpty {
                Divider().opacity(0.4)
                Button(L10n.tr("未分组")) {
                    project = ""
                    close()
                }
                .buttonStyle(.plain)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(width: 220)
        .onAppear { input = project }
    }
}

struct EstimatePopoverView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @Binding var estimate: String
    let close: () -> Void
    @State private var custom = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(L10n.tr("预计耗时")).font(.system(size: 12, weight: .semibold))
            HStack(spacing: 6) {
                ForEach(["15", "25", "45", "60"], id: \.self) { minutes in
                    Button("\(minutes)m") {
                        estimate = minutes
                        close()
                    }
                    .buttonStyle(CueButtonStyle(prominent: estimate == minutes))
                }
            }
            HStack(spacing: 6) {
                TextField("—", text: $custom)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 50)
                    .onSubmit {
                        if !custom.isEmpty { estimate = custom; close() }
                    }
                Text(L10n.tr("分钟")).font(.system(size: 12)).foregroundStyle(.secondary)
                Spacer()
                if !custom.isEmpty {
                    Button(L10n.tr("完成")) {
                        estimate = custom
                        close()
                    }
                    .controlSize(.small)
                }
            }
            if !estimate.isEmpty {
                Divider().opacity(0.4)
                Button(L10n.tr("清除")) {
                    estimate = ""
                    close()
                }
                .buttonStyle(.plain)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(width: 230)
        .onAppear { custom = estimate }
    }
}

struct RepeatPopoverView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @Binding var draft: TaskDraft
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(L10n.tr("重复"))
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                Picker("", selection: $draft.repeatKind) {
                    ForEach(RepeatKind.allCases) { Text($0.label).tag($0) }
                }
                .labelsHidden().frame(width: 100)
            }

            if draft.repeatKind == .weekly {
                HStack(spacing: 3) {
                    ForEach(1...7, id: \.self) { day in
                        let names = [L10n.tr("一"), L10n.tr("二"), L10n.tr("三"), L10n.tr("四"), L10n.tr("五"), L10n.tr("六"), L10n.tr("日")]
                        Toggle(names[day - 1], isOn: Binding(
                            get: { draft.weekdays.contains(day) },
                            set: { on in if on { draft.weekdays.insert(day) } else { draft.weekdays.remove(day) } }
                        ))
                        .toggleStyle(.button)
                        .controlSize(.small)
                        .frame(maxWidth: .infinity)
                    }
                }
            }

            if draft.repeatKind != .none {
                DatePicker(L10n.tr("开始"), selection: $draft.repeatStart, displayedComponents: .date)
                    .datePickerStyle(.compact)

                HStack {
                    Toggle(L10n.tr("固定时间"), isOn: $draft.repeatTimeOn).toggleStyle(.switch).controlSize(.mini)
                    Spacer()
                    if draft.repeatTimeOn {
                        DatePicker("", selection: $draft.repeatTime, displayedComponents: .hourAndMinute).labelsHidden()
                    }
                }
                HStack {
                    Toggle(L10n.tr("每次提醒"), isOn: $draft.repeatReminderOn).toggleStyle(.switch).controlSize(.mini)
                    Spacer()
                    if draft.repeatReminderOn {
                        DatePicker("", selection: $draft.repeatReminderTime, displayedComponents: .hourAndMinute).labelsHidden()
                    }
                }
                Text(L10n.tr("重复任务使用这里的开始日期、时间与提醒。"))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Text(L10n.tr("按所选日期自动重复，每次可单独编辑或跳过。"))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }

            HStack {
                Spacer()
                Button(L10n.tr("完成"), action: close)
                    .buttonStyle(CueButtonStyle(prominent: true))
                    .controlSize(.small)
            }
        }
        .padding(14)
        .frame(width: 270)
        .onChange(of: draft.repeatKind) { old, new in
            if old == .none, new != .none, draft.scheduledMode != .none { draft.repeatStart = draft.scheduledDate }
        }
        .todoCueAccent()
    }
}
