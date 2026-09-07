import SwiftUI
import TodoCueKit

struct TaskFormView: View {
    @EnvironmentObject var model: AppModel
    @State var draft: TaskDraft
    @State private var error: String?
    @State private var saving = false
    @FocusState private var titleFocused: Bool

    init(draft: TaskDraft) { _draft = State(initialValue: draft) }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    TextField("标题", text: $draft.title)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 14))
                        .focused($titleFocused)
                        .onSubmit(save)
                        .accessibilityLabel("标题")

                    TextField("备注", text: $draft.notes, axis: .vertical)
                        .lineLimit(2...6)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("备注")

                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("项目").font(.system(size: 11)).foregroundStyle(.secondary)
                            HStack(spacing: 4) {
                                TextField("项目", text: $draft.project).textFieldStyle(.roundedBorder).accessibilityLabel("项目")
                                if !model.projects.isEmpty {
                                    Menu {
                                        ForEach(model.projects, id: \.self) { p in Button(p) { draft.project = p } }
                                    } label: { Image(systemName: "chevron.down") }
                                    .menuStyle(.borderlessButton).menuIndicator(.hidden).frame(width: 18)
                                    .accessibilityLabel("选择已有项目")
                                }
                            }
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            Text("优先级").font(.system(size: 11)).foregroundStyle(.secondary)
                            Picker("优先级", selection: $draft.priority) {
                                ForEach(Priority.allCases, id: \.self) { Text($0.label).tag($0) }
                            }
                            .labelsHidden()
                            .frame(width: 80)
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            Text("耗时(分)").font(.system(size: 11)).foregroundStyle(.secondary)
                            TextField("30", text: $draft.estimate).textFieldStyle(.roundedBorder).frame(width: 56)
                                .accessibilityLabel("预计耗时分钟")
                        }
                    }

                    if draft.repeatKind == .none {
                        DateModeField(title: "计划", mode: $draft.scheduledMode, date: $draft.scheduledDate)
                        DateModeField(title: "截止", mode: $draft.dueMode, date: $draft.dueDate)
                        VStack(alignment: .leading, spacing: 6) {
                            Toggle("提醒", isOn: $draft.reminderOn).toggleStyle(.checkbox).font(.system(size: 12, weight: .medium))
                            if draft.reminderOn {
                                DatePicker("提醒时间", selection: $draft.reminderDate, displayedComponents: [.date, .hourAndMinute])
                                    .labelsHidden().datePickerStyle(.compact)
                            }
                        }
                    }

                    if !draft.isEditing {
                        repeatSection
                    } else if draft.isSeriesInstance {
                        Label("这是重复任务的一个实例，修改只影响本次。", systemImage: "repeat")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }

                    if let error {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 12)).foregroundStyle(.orange)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
            }
            Divider().opacity(0.5)
            HStack {
                Button("取消") { model.handleEscape() }.keyboardShortcut(.cancelAction)
                Spacer()
                if !model.canWrite { Text("离线，无法保存").font(.system(size: 11)).foregroundStyle(.secondary) }
                Button(draft.isEditing ? "保存" : "添加", action: save)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(saving || !model.canWrite)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
        .onAppear { titleFocused = true }
        .onChange(of: draft) { _, new in
            // Keep the draft in the route so Esc can preserve it.
            if case .form = model.routes.last { model.routes[model.routes.count - 1] = .form(new) }
        }
    }

    private var repeatSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("重复").font(.system(size: 12, weight: .medium))
                Picker("重复", selection: $draft.repeatKind) {
                    ForEach(RepeatKind.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden()
            }
            if draft.repeatKind == .weekly {
                HStack(spacing: 4) {
                    ForEach(1...7, id: \.self) { d in
                        let names = ["一", "二", "三", "四", "五", "六", "日"]
                        Toggle(names[d - 1], isOn: Binding(
                            get: { draft.weekdays.contains(d) },
                            set: { on in if on { draft.weekdays.insert(d) } else { draft.weekdays.remove(d) } }
                        ))
                        .toggleStyle(.button).controlSize(.small)
                        .accessibilityLabel("周\(names[d - 1])")
                    }
                }
            }
            if draft.repeatKind != .none {
                HStack(spacing: 12) {
                    DatePicker("开始", selection: $draft.repeatStart, displayedComponents: .date).datePickerStyle(.compact)
                }
                HStack(spacing: 12) {
                    Toggle("时间", isOn: $draft.repeatTimeOn).toggleStyle(.checkbox)
                    if draft.repeatTimeOn {
                        DatePicker("时间", selection: $draft.repeatTime, displayedComponents: .hourAndMinute).labelsHidden()
                    }
                    Toggle("提醒", isOn: $draft.repeatReminderOn).toggleStyle(.checkbox)
                    if draft.repeatReminderOn {
                        DatePicker("提醒", selection: $draft.repeatReminderTime, displayedComponents: .hourAndMinute).labelsHidden()
                    }
                }
                Text("每日或每周生成实例，未来 30 天自动补齐；修改规则请停止后重新创建。")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
        .font(.system(size: 12))
    }

    private func save() {
        guard !saving else { return }
        error = nil
        saving = true
        Task {
            let err = await model.save(draft)
            saving = false
            if let err { error = err } else { model.pop() }
        }
    }
}

struct DateModeField: View {
    let title: String
    @Binding var mode: DateMode
    @Binding var date: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title).font(.system(size: 12, weight: .medium)).frame(width: 32, alignment: .leading)
                Picker(title, selection: $mode) {
                    ForEach(DateMode.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden()
            }
            if mode != .none {
                DatePicker(title, selection: $date, displayedComponents: mode == .date ? [.date] : [.date, .hourAndMinute])
                    .labelsHidden().datePickerStyle(.compact)
            }
        }
    }
}
