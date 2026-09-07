import SwiftUI
import TodoCueKit

/// Next card + tabs + lists + quick add + completed today.
struct ListRootView: View {
    @EnvironmentObject var model: AppModel
    @State private var completedExpanded = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let n = model.next?.next {
                        NextCard(candidate: n)
                    }
                    Picker("视图", selection: $model.tab) {
                        ForEach(PanelTab.allCases) { t in Text(t.label).tag(t) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .accessibilityLabel("任务视图切换")

                    switch model.tab {
                    case .today: TodayListView()
                    case .upcoming: UpcomingListView()
                    case .all: AllListView()
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 12)
                .padding(.bottom, 16)
            }
            .scrollIndicators(.automatic)

            Divider().opacity(0.5)
            QuickAddView()
            if !model.today.completed.isEmpty {
                CompletedTodayView(expanded: $completedExpanded)
            }
        }
    }
}

struct NextCard: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    let candidate: NextCandidate

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("下一项", systemImage: "arrow.forward.circle.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(accent)
                Spacer()
                Text(candidate.group.label)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            HStack(alignment: .top, spacing: 10) {
                CheckButton(task: candidate.task)
                Button { model.routes.append(.detail(candidate.task.id)) } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(candidate.task.title)
                            .font(.system(size: 15, weight: .semibold))
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        let meta = TaskMeta.line(for: candidate.task)
                        if !meta.isEmpty {
                            Text(meta).font(.system(size: 12)).foregroundStyle(candidate.task.isOverdue ? .red : .secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("打开 \(candidate.task.title)")
            }
        }
        .padding(14)
        .background(accent.opacity(0.09), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(accent.opacity(0.25), lineWidth: 0.5))
    }
}

struct SectionHeader: View {
    let title: String
    var count: Int? = nil
    var color: Color = .secondary

    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(color)
            if let count { Text("\(count)").font(.system(size: 11)).foregroundStyle(.secondary) }
            Spacer()
        }
        .padding(.top, 4)
        .accessibilityAddTraits(.isHeader)
    }
}

struct EmptyStateView: View {
    let text: String
    var systemImage = "checkmark.seal"

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: systemImage).font(.system(size: 26)).foregroundStyle(.secondary)
            Text(text).font(.system(size: 13)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 30)
    }
}

struct TodayListView: View {
    @EnvironmentObject var model: AppModel

    private var sections: [(TodaySection, [TodayItem])] {
        [TodaySection.overdue, .must, .scheduled].compactMap { s in
            let items = model.today.items.filter { $0.section == s && $0.task.status == .todo }
            return items.isEmpty ? nil : (s, items)
        }
    }

    var body: some View {
        if model.connectionState == .connecting && model.today.date.isEmpty {
            EmptyStateView(text: "正在连接…", systemImage: "antenna.radiowaves.left.and.right")
        } else if model.connectionState == .noRuntime && model.today.date.isEmpty {
            EmptyStateView(text: "无法连接 TodoCue 运行时\n运行 `todocue service start`", systemImage: "bolt.slash")
        } else if sections.isEmpty {
            EmptyStateView(text: "今天没有待办 🎉")
        } else {
            ForEach(sections, id: \.0) { section, items in
                VStack(spacing: 2) {
                    SectionHeader(title: section.label, count: items.count, color: section == .overdue ? .red : .secondary)
                    ForEach(items) { item in
                        TaskRowView(task: item.task, reasons: item.reasons)
                    }
                }
            }
        }
    }
}

struct UpcomingListView: View {
    @EnvironmentObject var model: AppModel

    private var groups: [(String, [TodoTask])] {
        let dict = Dictionary(grouping: model.upcoming) { $0.planDate ?? "" }
        return dict.keys.sorted().map { ($0, dict[$0]!) }
    }

    var body: some View {
        if groups.isEmpty {
            EmptyStateView(text: "没有即将到来的任务", systemImage: "calendar")
        } else {
            ForEach(groups, id: \.0) { date, tasks in
                VStack(spacing: 2) {
                    SectionHeader(title: TCDate.dateLabel(date), count: tasks.count)
                    ForEach(tasks) { t in TaskRowView(task: t, reasons: []) }
                }
            }
        }
    }
}

struct AllListView: View {
    @EnvironmentObject var model: AppModel

    private var groups: [(String, [TodoTask])] {
        let dict = Dictionary(grouping: model.allTasks) { $0.project ?? "" }
        let keys = dict.keys.sorted { a, b in
            if a.isEmpty != b.isEmpty { return b.isEmpty } // named projects first
            return a < b
        }
        return keys.map { ($0, dict[$0]!) }
    }

    var body: some View {
        if model.allTasks.isEmpty {
            EmptyStateView(text: "没有待办任务", systemImage: "tray")
        } else {
            ForEach(groups, id: \.0) { project, tasks in
                VStack(spacing: 2) {
                    SectionHeader(title: project.isEmpty ? "未分组" : project, count: tasks.count)
                    ForEach(tasks) { t in TaskRowView(task: t, reasons: [], showProject: false) }
                }
            }
        }
    }
}

struct QuickAddView: View {
    @EnvironmentObject var model: AppModel
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "plus.circle.fill").foregroundStyle(.secondary)
            TextField("快速添加任务，回车创建", text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .focused($focused)
                .onSubmit {
                    guard model.canWrite else { return }
                    model.quickAdd(text)
                    text = ""
                }
                .disabled(!model.canWrite)
                .accessibilityLabel("快速添加任务")
            Button {
                var d = model.savedDraft ?? TaskDraft()
                if !text.isEmpty { d.title = text; text = "" }
                model.routes.append(.form(d))
            } label: {
                Image(systemName: "slider.horizontal.3").foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("展开完整表单")
            .accessibilityLabel("展开完整表单")
            .disabled(!model.canWrite)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .onChange(of: model.quickAddFocusRequest) { _, _ in focused = true }
    }
}

struct CompletedTodayView: View {
    @EnvironmentObject var model: AppModel
    @Binding var expanded: Bool

    var body: some View {
        VStack(spacing: 0) {
            Divider().opacity(0.5)
            Button { withAnimation(Theme.listChange) { expanded.toggle() } } label: {
                HStack {
                    Image(systemName: "chevron.right").rotationEffect(.degrees(expanded ? 90 : 0)).font(.system(size: 10, weight: .bold))
                    Text("今日已完成 (\(model.today.completed.count))").font(.system(size: 12, weight: .medium))
                    Spacer()
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 18)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(expanded ? "收起今日已完成" : "展开今日已完成")
            if expanded {
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(model.today.completed) { t in
                            TaskRowView(task: t, reasons: [])
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.bottom, 10)
                }
                .frame(maxHeight: 160)
            }
        }
    }
}
