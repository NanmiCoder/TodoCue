import SwiftUI
import TodoCueKit

struct TaskFormView: View {
    @EnvironmentObject var model: AppModel
    @State var draft: TaskDraft
    @State private var error: String?
    @State private var saving = false
    @State private var importingAttachments = false
    @State private var scheduleExpanded: Bool
    @FocusState private var titleFocused: Bool

    init(draft: TaskDraft) {
        _draft = State(initialValue: draft)
        _scheduleExpanded = State(initialValue: draft.scheduledMode != .none || draft.dueMode != .none || draft.reminderOn || draft.repeatKind != .none)
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { scroll in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("要做什么").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                            TextField("给任务起个名字", text: $draft.title, axis: .vertical)
                                .lineLimit(2...4)
                                .font(.system(size: 20, weight: .medium)).tracking(-0.35)
                                .focused($titleFocused)
                                .accessibilityLabel("标题")
                            Divider().opacity(0.5)
                            TextField("添加备注、链接或想法（可选）", text: $draft.notes, axis: .vertical)
                                .lineLimit(2...5)
                                .font(.system(size: 13))
                                .accessibilityLabel("备注")
                        }
                        .textFieldStyle(.plain)
                        .padding(16)
                        .cueSurface()

                        AttachmentEditorView(draft: $draft, loading: $importingAttachments)

                        EditorSection(title: "任务属性", icon: "slider.horizontal.3") {
                            EditorFieldRow(title: "项目", icon: "folder") {
                                HStack(spacing: 6) {
                                    TextField("未分组", text: $draft.project)
                                        .textFieldStyle(.roundedBorder).accessibilityLabel("项目")
                                    if !model.projects.isEmpty {
                                        Menu {
                                            ForEach(model.projects, id: \.self) { project in Button(project) { draft.project = project } }
                                        } label: { Image(systemName: "chevron.down") }
                                        .menuStyle(.borderlessButton).menuIndicator(.hidden).frame(width: 18)
                                        .accessibilityLabel("选择已有项目")
                                    }
                                }
                            }
                            EditorFieldRow(title: "优先级", icon: "flag") {
                                Picker("优先级", selection: $draft.priority) {
                                    ForEach(Priority.allCases, id: \.self) { Text($0.label).tag($0) }
                                }.labelsHidden().frame(width: 82, alignment: .leading)
                            }
                            EditorFieldRow(title: "预计", icon: "timer") {
                                HStack(spacing: 6) {
                                    TextField("—", text: $draft.estimate)
                                        .textFieldStyle(.roundedBorder).frame(width: 48)
                                        .accessibilityLabel("预计耗时分钟")
                                    Text("分钟").foregroundStyle(.secondary)
                                }
                            }
                        }
                        DisclosureGroup(isExpanded: Binding(get: { scheduleExpanded }, set: { expanded in
                            withAnimation(Theme.interaction) { scheduleExpanded = expanded } completion: {
                                if expanded {
                                    withAnimation(Theme.interaction) { scroll.scrollTo("task-schedule", anchor: .top) }
                                }
                            }
                        })) {
                            VStack(alignment: .leading, spacing: 14) {
                                if draft.repeatKind == .none {
                                    DateModeField(title: "计划", mode: $draft.scheduledMode, date: $draft.scheduledDate)
                                    DateModeField(title: "截止", mode: $draft.dueMode, date: $draft.dueDate)
                                    VStack(alignment: .leading, spacing: 9) {
                                        Toggle("提醒", isOn: $draft.reminderOn).toggleStyle(.switch).controlSize(.mini)
                                        if draft.reminderOn {
                                            CompactDateField(title: "提醒", date: $draft.reminderDate, includesTime: true)
                                        }
                                    }
                                }
                                if !draft.isEditing { repeatSection }
                                else if draft.isSeriesInstance {
                                    Label("重复任务 · 修改只影响本次", systemImage: "repeat")
                                        .font(.system(size: 12)).foregroundStyle(.secondary)
                                }
                            }.padding(.top, 14)
                        } label: {
                            Label("时间与重复", systemImage: "calendar")
                                .font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
                        }
                        .padding(16).cueSurface().id("task-schedule")
                    }
                    .font(.system(size: 12))
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
                }
                .disabled(saving)
            }
            VStack(alignment: .leading, spacing: 10) {
                if let error {
                    Label(error, systemImage: "exclamationmark.circle")
                        .font(.system(size: 12)).foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Text(model.canWrite ? "返回会保留草稿" : "离线，草稿已保留")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    if saving { ProgressView().controlSize(.small) }
                    Button(draft.isEditing ? "保存更改" : "添加任务", action: save)
                        .buttonStyle(CueButtonStyle(prominent: true))
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(saving || importingAttachments || !model.canWrite)
                        .help("⌘Return 保存")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .task {
            // Wait until the hosting view is attached to the key panel.
            await Task.yield()
            titleFocused = true
        }
        .defaultFocus($titleFocused, true)
        .onChange(of: draft) { old, new in
            if error != nil && error == old.validate() { error = new.validate() }
            if case .form = model.routes.last { model.routes[model.routes.count - 1] = .form(new) }
        }
    }

    private var repeatSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("重复")
                Spacer()
                Picker("重复", selection: $draft.repeatKind) {
                    ForEach(RepeatKind.allCases) { Text($0.label).tag($0) }
                }.labelsHidden().frame(width: 136)
            }
            if draft.repeatKind == .weekly {
                HStack(spacing: 4) {
                    ForEach(1...7, id: \.self) { day in
                        let names = ["一", "二", "三", "四", "五", "六", "日"]
                        Toggle(names[day - 1], isOn: Binding(
                            get: { draft.weekdays.contains(day) },
                            set: { on in if on { draft.weekdays.insert(day) } else { draft.weekdays.remove(day) } }
                        ))
                        .toggleStyle(.button).controlSize(.small)
                        .frame(maxWidth: .infinity)
                        .accessibilityLabel("周\(names[day - 1])")
                    }
                }
            }
            if draft.repeatKind != .none {
                CompactDateField(title: "开始", date: $draft.repeatStart)
                HStack {
                    Toggle("固定时间", isOn: $draft.repeatTimeOn).toggleStyle(.switch).controlSize(.mini)
                    if draft.repeatTimeOn {
                        DatePicker("时间", selection: $draft.repeatTime, displayedComponents: .hourAndMinute).labelsHidden()
                    }
                }
                HStack {
                    Toggle("每次提醒", isOn: $draft.repeatReminderOn).toggleStyle(.switch).controlSize(.mini)
                    if draft.repeatReminderOn {
                        DatePicker("提醒", selection: $draft.repeatReminderTime, displayedComponents: .hourAndMinute).labelsHidden()
                    }
                }
                Text("按所选日期自动重复，每次可单独编辑或跳过。")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
    }

    private func save() {
        guard !saving, !importingAttachments else { return }
        error = draft.validate()
        guard error == nil else { return }
        saving = true
        let submitted = draft
        Task {
            let err = await model.save(submitted)
            saving = false
            if let err { error = err }
            else if case .form(let current) = model.routes.last, current == submitted {
                model.pop(preservingDraft: false)
            }
        }
    }
}

struct DateModeField: View {
    let title: String
    @Binding var mode: DateMode
    @Binding var date: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text(title)
                Spacer()
                Picker(title, selection: $mode) {
                    ForEach(DateMode.allCases) { Text($0.label).tag($0) }
                }.labelsHidden().frame(width: 136)
            }
            if mode != .none {
                CompactDateField(title: title, date: $date, includesTime: mode == .dateTime)
            }
        }
    }
}

/// Native text/time entry plus a calendar that remains inside the panel's interaction scope.
struct CompactDateField: View {
    let title: String
    @Binding var date: Date
    var includesTime = false
    @State private var calendarOpen = false

    var body: some View {
        FlowLayout(spacing: 8) {
            HStack(spacing: 8) {
                DatePicker(title, selection: $date, displayedComponents: .date)
                    .labelsHidden().datePickerStyle(.compact).fixedSize()
                    .accessibilityLabel(title + "日期")
                calendarButton
            }
            if includesTime {
                DatePicker(title + "时间", selection: $date, displayedComponents: .hourAndMinute)
                    .labelsHidden().datePickerStyle(.compact).fixedSize()
                    .accessibilityLabel(title + "时间")
            }
        }
    }

    private var calendarButton: some View {
        Button { calendarOpen.toggle() } label: { Image(systemName: "calendar") }
                .buttonStyle(QuietIconButtonStyle())
                .accessibilityLabel("选择" + title + "日期")
                .popover(isPresented: $calendarOpen, arrowEdge: .trailing) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("选择" + title + "日期").font(.system(size: 13, weight: .semibold))
                        DatePicker(title, selection: $date, displayedComponents: .date)
                            .datePickerStyle(.graphical).labelsHidden()
                        HStack {
                            Button("今天") { setDay(Date()) }
                            Button("明天") { setDay(Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()) }
                            Spacer()
                            Button("完成") { calendarOpen = false }.buttonStyle(.borderedProminent)
                        }
                        .controlSize(.small)
                    }
                    .padding(16)
                    .frame(width: 280)
                    .todoCueAccent()
                }
    }

    private func setDay(_ day: Date) {
        let c = Calendar.current
        let time = c.dateComponents([.hour, .minute], from: date)
        date = c.date(bySettingHour: time.hour ?? 9, minute: time.minute ?? 0, second: 0, of: day) ?? day
    }
}
