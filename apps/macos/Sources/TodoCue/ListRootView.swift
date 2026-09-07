import SwiftUI
import TodoCueKit

/// Next card + tabs + lists + quick add + completed today.
struct ListRootView: View {
    @EnvironmentObject var model: AppModel
    @State private var completedExpanded = false

    var body: some View {
        GeometryReader { geometry in
            // Grow both outer gutters smoothly from 12pt at 300pt to 16pt at 340pt.
            let horizontalInset = min(16, 12 + max(0, geometry.size.width - Theme.panelMinWidth) * 0.1)

            VStack(spacing: 10) {
                TabBarView().padding(.horizontal, 18)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if model.tab == .today, let next = model.next?.next { NextCard(candidate: next) }
                        switch model.tab {
                        case .today: TodayListView()
                        case .upcoming: UpcomingListView()
                        case .all: AllListView()
                        }
                        if model.tab == .today, !model.today.completed.isEmpty {
                            CompletedTodayView(expanded: $completedExpanded)
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .id(model.tab)
                .scrollIndicators(.automatic)
                .cueSurface(radius: 18)
                .padding(.horizontal, horizontalInset)
                QuickAddView().padding(.horizontal, horizontalInset)
            }
        }
    }
}

/// A single navigation lens with a sliding selection; content never changes the hit targets.
private struct TabBarView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    @Namespace private var selection

    var body: some View {
        HStack(spacing: 2) {
            ForEach(PanelTab.allCases) { tab in
                Button { withAnimation(Theme.interaction) { model.tab = tab } } label: {
                    Text(tab.label).font(.system(size: 12, weight: model.tab == tab ? .semibold : .medium))
                        .frame(maxWidth: .infinity).frame(height: 32)
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .foregroundStyle(model.tab == tab ? Color.primary : .secondary)
                .background {
                    if model.tab == tab {
                        Capsule().fill(Theme.surface)
                            .overlay(Capsule().strokeBorder(Color.white.opacity(0.3), lineWidth: 0.5))
                            .shadow(color: .black.opacity(0.055), radius: 3, y: 1)
                            .matchedGeometryEffect(id: "selected-tab", in: selection)
                    }
                }
                .accessibilityLabel(tab.label)
                .accessibilityAddTraits(model.tab == tab ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Color.primary.opacity(0.045), in: Capsule())
        .accessibilityElement(children: .contain).accessibilityLabel("任务视图切换")
    }
}

struct NextCard: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    let candidate: NextCandidate
    @State private var hovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 6) {
                Circle().fill(accent).frame(width: 5, height: 5)
                Text("下一步").font(.system(size: 11, weight: .semibold)).foregroundStyle(accent)
                Spacer(minLength: 4)
                Text(candidate.group.label).font(.system(size: 10, weight: .medium))
                    .foregroundStyle(candidate.task.isOverdue ? Theme.overdue : .secondary)
            }
            Button { model.routes.append(.detail(candidate.task.id)) } label: {
                Text(candidate.task.title)
                    .font(.system(size: 17, weight: .semibold)).tracking(-0.3)
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityLabel("打开 \(candidate.task.title)")
            TaskMetadataView(task: candidate.task, emphasized: true)
            HStack {
                Button { model.complete(candidate.task) } label: { Label("完成", systemImage: "checkmark") }
                    .buttonStyle(CueButtonStyle(prominent: true))
                    .disabled(!model.canWrite || model.completingTaskIDs.contains(candidate.task.id))
                    .accessibilityLabel("完成 \(candidate.task.title)")
                Spacer()
                Button { model.routes.append(.detail(candidate.task.id)) } label: {
                    Image(systemName: "chevron.right").foregroundStyle(accent)
                }
                .buttonStyle(QuietIconButtonStyle()).accessibilityLabel("查看下一步详情")
            }
        }
        .padding(12)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(accent.opacity(hovered ? 0.10 : 0.065))
        }
        .overlay(alignment: .leading) {
            Capsule().fill(accent.opacity(0.5)).frame(width: 2, height: 22).padding(.leading, -1)
        }
        .onHover { hovered = $0 }
        .animation(Theme.interaction, value: hovered)
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
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    let text: String
    var systemImage = "checkmark.seal"
    var allowsAdd = false

    var body: some View {
        VStack(spacing: 18) {
            ZStack {
                Circle().stroke(accent.opacity(0.065), lineWidth: 1).frame(width: 108, height: 108)
                Circle().stroke(accent.opacity(0.12), lineWidth: 1).frame(width: 80, height: 80)
                Circle().fill(accent.opacity(0.07)).frame(width: 56, height: 56)
                Image(systemName: systemImage).font(.system(size: 22, weight: .light)).foregroundStyle(accent)
            }
            .accessibilityHidden(true)
            VStack(spacing: 8) {
                Text(text.components(separatedBy: "\n").first ?? text)
                    .font(.system(size: 17, weight: .medium)).tracking(-0.3)
                if text.contains("\n") {
                    Text(text.components(separatedBy: "\n").dropFirst().joined(separator: "\n"))
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
            .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            if allowsAdd {
                Button { model.focusQuickAdd() } label: { Label("记下一件事", systemImage: "plus") }
                    .buttonStyle(CueButtonStyle()).disabled(!model.canWrite)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 34)
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
            EmptyStateView(text: model.today.completed.isEmpty ? "从一件小事开始\n记下来，就不用一直惦记。" : "今天已清空\n完成了 \(model.today.completed.count) 件事，留点时间给自己。", systemImage: model.today.completed.isEmpty ? "plus" : "checkmark", allowsAdd: true)
        } else {
            ForEach(sections, id: \.0) { section, items in
                VStack(spacing: 2) {
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
    @State private var query = ""

    private var groups: [(String, [TodoTask])] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let tasks = model.allTasks.filter { term.isEmpty || [$0.title, $0.project ?? "", $0.notes ?? ""].contains { $0.localizedStandardContains(term) } }
        let dict = Dictionary(grouping: tasks) { $0.project ?? "" }
        let keys = dict.keys.sorted { a, b in
            if a.isEmpty != b.isEmpty { return b.isEmpty } // named projects first
            return a < b
        }
        return keys.map { ($0, dict[$0]!) }
    }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("搜索任务、项目或备注", text: $query).textFieldStyle(.plain).accessibilityLabel("搜索任务")
            if !query.isEmpty {
                Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                    .buttonStyle(.plain).accessibilityLabel("清除搜索")
            }
        }
        .font(.system(size: 12)).padding(10).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
        if groups.isEmpty {
            EmptyStateView(text: query.isEmpty ? "所有事情，都已妥当\n有新想法时，随时记下来。" : "没有找到相关任务\n试试其他关键词。", systemImage: query.isEmpty ? "tray" : "magnifyingglass", allowsAdd: query.isEmpty)
        } else {
            ForEach(groups, id: \.0) { project, tasks in
                VStack(spacing: 2) {
                    SectionHeader(title: project.isEmpty ? "未分组" : project, count: tasks.count)
                    ForEach(tasks) { t in TaskRowView(task: t, reasons: [], showProject: false, compact: true) }
                }
            }
        }
    }
}

struct QuickAddView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    @FocusState private var focused: Bool
    private var hasText: Bool { !model.quickAddText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "plus").font(.system(size: 16, weight: .light)).foregroundStyle(accent)
                    .frame(width: 24).accessibilityHidden(true)
                TextField("添加到今天…", text: $model.quickAddText,
                          prompt: Text("添加到今天…").foregroundColor(.secondary))
                    .textFieldStyle(.plain).font(.system(size: 13))
                    .focused($focused).onSubmit { model.quickAdd() }
                    .disabled(!model.canWrite || model.isQuickAdding)
                    .accessibilityLabel("快速添加到今天")
                if model.isQuickAdding { ProgressView().controlSize(.small) }
                else if hasText {
                    Button { model.quickAdd() } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 23)).foregroundStyle(accent) }
                        .buttonStyle(.plain).accessibilityLabel("添加到今天").help("添加到今天（回车）")
                        .disabled(!model.canWrite)
                } else {
                    Button(action: expand) { Image(systemName: "square.and.pencil") }
                        .buttonStyle(QuietIconButtonStyle()).foregroundStyle(.secondary)
                        .accessibilityLabel(model.savedDraft == nil ? "展开完整表单" : "继续草稿")
                        .help(model.savedDraft == nil ? "展开完整表单（⌘N）" : "继续未保存的草稿")
                        .disabled(!model.canWrite)
                }
            }
            if focused || hasText {
                HStack {
                    Label("今天", systemImage: "calendar").foregroundStyle(.secondary)
                    Spacer()
                    Button("添加详情", action: expand).buttonStyle(.plain).foregroundStyle(accent)
                        .disabled(!model.canWrite || model.isQuickAdding)
                    Text("↵").font(.system(size: 12)).foregroundStyle(.tertiary).accessibilityHidden(true)
                }
                .font(.system(size: 11))
                .padding(.leading, 4)
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 11)
        // Fill and stroke must share the corner style, or the fill peeks past the stroke at the corners.
        .background(Theme.insetSurface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
            .strokeBorder(focused ? accent.opacity(0.55) : Color.white.opacity(0.12), lineWidth: focused ? 1 : 0.5))
        .padding(.bottom, 12)
        .animation(Theme.interaction, value: focused || hasText)
        .onChange(of: model.quickAddFocusRequest) { _, _ in focused = true }
        .onChange(of: model.isQuickAdding) { _, adding in
            if !adding {
                DispatchQueue.main.async {
                    // Restore the insertion point only while the user is still in this panel.
                    if NSApp.keyWindow is SidePanelWindow { focused = true }
                }
            }
        }
        .onAppear { if model.quickAddFocusRequest > 0 { focused = true } }
    }

    private func expand() {
        var draft = model.savedDraft ?? TaskDraft()
        if hasText {
            draft.title = model.quickAddText
            draft.scheduledMode = .date
            model.quickAddText = ""
        }
        model.presentForm(draft)
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
