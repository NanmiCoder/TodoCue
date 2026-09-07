import SwiftUI
import TodoCueKit

/// Next card + tabs + lists + quick add + completed today.
struct ListRootView: View {
    @EnvironmentObject var model: AppModel
    @State private var completedExpanded = false

    var body: some View {
        VStack(spacing: 0) {
            TabBarView()
                .padding(.horizontal, 20)
                .padding(.top, 10)
                .padding(.bottom, 12)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if model.tab == .today, let n = model.next?.next {
                        NextCard(candidate: n)
                    }
                    switch model.tab {
                    case .today: TodayListView()
                    case .upcoming: UpcomingListView()
                    case .all: AllListView()
                    }
                    if model.tab == .today, !model.today.completed.isEmpty {
                        CompletedTodayView(expanded: $completedExpanded)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
            }
            .scrollIndicators(.automatic)
            Divider().opacity(0.4)
            QuickAddView()
        }
    }
}

/// Equal-width, persistent navigation stays reachable when the task list scrolls.
private struct TabBarView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent

    var body: some View {
        HStack(spacing: 3) {
            ForEach(PanelTab.allCases) { tab in
                Button { model.tab = tab } label: {
                    Text(tab.label)
                        .font(.system(size: 12, weight: model.tab == tab ? .semibold : .medium))
                        .frame(maxWidth: .infinity)
                        .frame(height: 29)
                        .contentShape(RoundedRectangle(cornerRadius: 7))
                }
                .buttonStyle(.plain)
                .foregroundStyle(model.tab == tab ? accent : .secondary)
                .background(model.tab == tab ? Color(nsColor: .controlBackgroundColor) : .clear,
                            in: RoundedRectangle(cornerRadius: 7))
                .shadow(color: .black.opacity(model.tab == tab ? 0.05 : 0), radius: 2, y: 1)
                .accessibilityLabel(tab.label)
                .accessibilityAddTraits(model.tab == tab ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("任务视图切换")
    }
}

struct NextCard: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    let candidate: NextCandidate

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("接下来", systemImage: "arrow.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(accent)
                Spacer()
                Text(candidate.group.label)
                    .font(.system(size: 11))
                    .foregroundStyle(candidate.task.isOverdue ? Theme.overdue : .secondary)
            }
            HStack(alignment: .top, spacing: 10) {
                CheckButton(task: candidate.task)
                Button { model.routes.append(.detail(candidate.task.id)) } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(candidate.task.title)
                            .font(.system(size: 15, weight: .semibold))
                            .fixedSize(horizontal: false, vertical: true)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        let meta = TaskMeta.line(for: candidate.task, includeDeadline: !candidate.task.isOverdue)
                        if candidate.task.isOverdue, let due = TaskMeta.dueLabel(candidate.task) {
                            (Text("截止 " + due).foregroundColor(Theme.overdue)
                             + Text(meta.isEmpty ? "" : " · " + meta).foregroundColor(.secondary))
                                .font(.system(size: 12)).lineLimit(2)
                        } else if !meta.isEmpty {
                            Text(meta).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(2)
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
        .background(accent.opacity(0.075), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(accent.opacity(0.18), lineWidth: 0.5))
    }
}

struct SectionHeader: View {
    let title: String
    var count: Int? = nil
    var color: Color = .secondary

    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(color)
            if let count { Text("\(count)").font(.system(size: 11, weight: .medium)).monospacedDigit().foregroundStyle(.secondary) }
            Spacer()
        }
        .padding(.horizontal, 4)
        .padding(.top, 2)
        .accessibilityAddTraits(.isHeader)
    }
}

struct EmptyStateView: View {
    let text: String
    var systemImage = "checkmark.seal"

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: systemImage).font(.system(size: 26)).foregroundStyle(.secondary)
            Text(text).font(.system(size: 13)).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 30)
    }
}

struct TodayListView: View {
    @EnvironmentObject var model: AppModel

    private var sections: [(TodaySection, [TodayItem])] {
        [TodaySection.overdue, .must, .scheduled].compactMap { s in
            let items = model.today.items.filter { $0.section == s && $0.task.status == .todo && $0.task.id != model.next?.next?.task.id }
            return items.isEmpty ? nil : (s, items)
        }
    }

    var body: some View {
        if model.today.date.isEmpty && (model.connectionState == .connecting || model.isLoading) {
            LoadingTasksView()
        } else if model.connectionState == .noRuntime && model.today.date.isEmpty {
            EmptyStateView(text: "连接后，任务会显示在这里", systemImage: "tray")
        } else if sections.isEmpty && model.next?.next == nil {
            EmptyStateView(text: "今天的任务都安排好了\n添加一件想做的小事", systemImage: "checkmark.circle")
        } else {
            ForEach(sections, id: \.0) { section, items in
                VStack(spacing: 6) {
                    SectionHeader(title: section.label, count: items.count, color: section == .overdue ? Theme.overdue : .secondary)
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
                VStack(spacing: 6) {
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
                VStack(spacing: 6) {
                    SectionHeader(title: project.isEmpty ? "未分组" : project, count: tasks.count)
                    ForEach(tasks) { t in TaskRowView(task: t, reasons: [], showProject: false) }
                }
            }
        }
    }
}

struct QuickAddView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "plus").font(.system(size: 14, weight: .medium)).foregroundStyle(accent)
                .accessibilityHidden(true)
            TextField("添加到今天…", text: $model.quickAddText)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .focused($focused)
                .onSubmit { model.quickAdd() }
                .disabled(!model.canWrite || model.isQuickAdding)
                .accessibilityLabel("快速添加到今天")
            if model.isQuickAdding {
                ProgressView().controlSize(.small)
            } else if !model.quickAddText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button { model.quickAdd() } label: { Image(systemName: "arrow.up.circle.fill") }
                    .buttonStyle(QuietIconButtonStyle())
                    .foregroundStyle(accent)
                    .help("添加到今天（回车）")
                    .accessibilityLabel("添加到今天")
                    .disabled(!model.canWrite)
            }
            Button {
                var draft = model.savedDraft ?? TaskDraft()
                if !model.quickAddText.isEmpty {
                    draft.title = model.quickAddText
                    draft.scheduledMode = .date
                    model.quickAddText = ""
                }
                model.presentForm(draft)
            } label: {
                Image(systemName: model.savedDraft == nil ? "slider.horizontal.3" : "square.and.pencil")
            }
            .buttonStyle(QuietIconButtonStyle())
            .help(model.savedDraft == nil ? "展开完整表单（⌘N）" : "继续未保存的草稿")
            .accessibilityLabel(model.savedDraft == nil ? "展开完整表单" : "继续草稿")
            .disabled(!model.canWrite || model.isQuickAdding)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 6)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(focused ? accent.opacity(0.6) : .clear, lineWidth: 1))
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .onChange(of: model.quickAddFocusRequest) { _, _ in focused = true }
        .onAppear { if model.quickAddFocusRequest > 0 { focused = true } }
    }
}

struct CompletedTodayView: View {
    @EnvironmentObject var model: AppModel
    @Binding var expanded: Bool

    var body: some View {
        VStack(spacing: 5) {
            Divider().opacity(0.4).padding(.bottom, 6)
            Button { withAnimation(Theme.listChange) { expanded.toggle() } } label: {
                HStack(spacing: 7) {
                    Image(systemName: "chevron.right").rotationEffect(.degrees(expanded ? 90 : 0))
                        .font(.system(size: 9, weight: .semibold))
                    Text("今日已完成").font(.system(size: 12, weight: .medium))
                    Text("\(model.today.completed.count)").font(.system(size: 12)).monospacedDigit()
                    Spacer()
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
                .padding(.vertical, 7)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(expanded ? "收起今日已完成" : "展开今日已完成")
            if expanded {
                ForEach(model.today.completed) { task in TaskRowView(task: task) }
            }
        }
    }
}

private struct LoadingTasksView: View {
    var body: some View {
        VStack(spacing: 18) {
            ForEach(0..<3) { _ in
                HStack(alignment: .top, spacing: 12) {
                    Circle().fill(Color.secondary.opacity(0.12)).frame(width: 18, height: 18)
                    VStack(alignment: .leading, spacing: 8) {
                        RoundedRectangle(cornerRadius: 4).fill(Color.secondary.opacity(0.12)).frame(height: 12)
                        RoundedRectangle(cornerRadius: 4).fill(Color.secondary.opacity(0.08)).frame(width: 170, height: 10)
                    }
                }
            }
        }
        .padding(.vertical, 16)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("正在加载任务")
    }
}
