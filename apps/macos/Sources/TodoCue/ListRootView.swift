import SwiftUI
import TodoCueKit

/// Next-step frost tile and the graphite list tile scroll together; quick add stays pinned below.
struct ListRootView: View {
    private static let top = "list-top"
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @State private var completedExpanded = false
    /// The tab shown before the current one; read during body so a switch knows its direction.
    @State private var previousTab: PanelTab = .today

    var body: some View {
        VStack(spacing: Dial.gap) {
            GeometryReader { geometry in
                ScrollViewReader { proxy in
                    ScrollView {
                        // Preserve the native drag source while edge-scrolling past it.
                        VStack(spacing: Dial.gap) {
                            if model.tab == .today, let next = model.next?.next {
                                NextCard(candidate: next)
                                    .dialTile(.frost)
                                    .transition(Theme.reduceMotion ? .opacity
                                                : .opacity.combined(with: .scale(scale: 0.96, anchor: .top)))
                                    .dialReveal(1)
                            }
                            // The tile stays put and opaque; only its rows change, so a tab switch
                            // never fades the graphite itself.
                            ZStack(alignment: .topLeading) {
                                VStack(alignment: .leading, spacing: 10) {
                                    switch model.tab {
                                    case .today: TodayListView()
                                    case .upcoming: UpcomingListView()
                                    case .all: AllListView()
                                    }
                                    if model.tab == .today, !model.today.completed.isEmpty {
                                        CompletedTodayView(expanded: $completedExpanded)
                                    }
                                }
                                .id(model.tab)
                                .transition(tabTransition)
                            }
                            .padding(.horizontal, 14).padding(.vertical, 14)
                            // The list tile always reaches the quick-add pill, however short the list.
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                            .dialTile(.graphite)
                            .dialReveal(2)
                        }
                        .frame(minHeight: geometry.size.height, alignment: .top)
                        .id(ListRootView.top)
                    }
                    // A legacy scroller would carve a gutter out of the tiles' right edge.
                    .scrollIndicators(.never)
                    .onChange(of: model.tab) { _, new in
                        // Recorded after the switch renders, so the next switch compares against it.
                        previousTab = new
                        // Each list starts at its top, as it did when every tab had its own scroller.
                        proxy.scrollTo(ListRootView.top, anchor: .top)
                    }
                }
                .overlay(alignment: .bottom) {
                    if model.isMovingTask {
                        ProgressView(L10n.tr("正在保存移动…")).controlSize(.small).font(.system(size: 11))
                            .padding(.horizontal, 12).padding(.vertical, 8).dialTile(.graphite, radius: 16).padding(8)
                            .transition(.opacity)
                    } else if let hint = model.dragHint {
                        Text(hint).font(.system(size: 11)).padding(.horizontal, 12).padding(.vertical, 8)
                            .dialTile(.graphite, radius: 16)
                            .padding(8).allowsHitTesting(false)
                            .transition(.opacity)
                    }
                }
                .animation(Dial.snap, value: model.dragHint)
            }
            QuickAddView().dialReveal(3)
        }
        .alert(L10n.tr("计划晚于截止时间"), isPresented: Binding(get: { model.pendingMove != nil }, set: { if !$0 { model.pendingMove = nil } }), presenting: model.pendingMove) { move in
            Button(L10n.tr("保留截止日期并改期")) { model.confirmMove(move) }.disabled(!model.canWrite || model.isMovingTask)
            Button(L10n.tr("取消"), role: .cancel) { model.pendingMove = nil }
        } message: { move in
            Text(L10n.tr("将「\(move.drag.task.title)」改期到 \(TCDate.dateLabel(move.target.group))，会晚于原截止时间。截止日期和提醒时间将保持原值。"))
        }
    }

    /// Rows follow the lit dot: they slide in from the side the selection moved towards, while the
    /// old rows simply clear out first.
    private var tabTransition: AnyTransition {
        if Theme.reduceMotion { return .opacity }
        let order = PanelTab.allCases
        let forward = (order.firstIndex(of: model.tab) ?? 0) >= (order.firstIndex(of: previousTab) ?? 0)
        return .asymmetric(
            insertion: .offset(x: forward ? 16 : -16).combined(with: .opacity)
                .animation(.spring(response: 0.34, dampingFraction: 0.9).delay(0.04)),
            removal: .opacity.animation(.easeOut(duration: 0.1)))
    }
}

/// The frost tile's content: what to do next, beside how far the day has come.
struct NextCard: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    let candidate: NextCandidate

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                DialMarker(text: "NEXT")
                Text(L10n.tr("下一步")).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                Spacer(minLength: 4)
                Text(candidate.group.label)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(candidate.task.isOverdue ? Theme.overdue : .secondary)
            }
            HStack(alignment: .top, spacing: 12) {
                ZStack(alignment: .topLeading) {
                    task(candidate.task)
                        .id(candidate.task.id)
                        .transition(Theme.reduceMotion ? .opacity
                                    : .asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity),
                                                  removal: .move(edge: .top).combined(with: .opacity)))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .clipped()
                DialGauge(completed: model.today.completed.count,
                          total: model.today.completed.count + model.remaining, diameter: 84)
                    .padding(.top, 2)
            }
        }
        .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 16)
        .animation(Dial.settle, value: candidate.task.id)
    }

    private func task(_ task: TodoTask) -> some View {
        let finishing = model.completingTaskIDs.contains(task.id)
        return VStack(alignment: .leading, spacing: 8) {
            Button { model.routes.append(.detail(task.id)) } label: {
                Text(task.title)
                    .font(.system(size: 16, weight: .semibold)).tracking(-0.25)
                    .strikethrough(finishing, color: .secondary)
                    .opacity(finishing ? 0.45 : 1)
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityLabel(L10n.tr("打开 \(task.title)"))
            TaskMetadataView(task: task, emphasized: true)
            HStack(spacing: 6) {
                Button { model.complete(task) } label: { Label(L10n.tr("完成"), systemImage: "checkmark") }
                    .buttonStyle(CueButtonStyle(prominent: true))
                    .disabled(!model.canWrite || model.completingTaskIDs.contains(task.id))
                    .accessibilityLabel(L10n.tr("完成 \(task.title)"))
                Button { model.routes.append(.detail(task.id)) } label: { Image(systemName: "arrow.up.right") }
                    .buttonStyle(QuietIconButtonStyle(width: 34))
                    .accessibilityLabel(L10n.tr("查看下一步详情"))
            }
            .padding(.top, 4)
        }
        .animation(.easeOut(duration: 0.2), value: finishing)
    }
}

struct SectionHeader: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    let title: String
    var count: Int? = nil
    var color: Color = .secondary

    var body: some View {
        HStack(spacing: 7) {
            Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(color)
            if let count { Text("\(count)").font(Dial.numeral(9.5)).monospacedDigit().foregroundStyle(.secondary) }
            Spacer()
        }
        .padding(.horizontal, 4)
        .padding(.top, 2)
        .accessibilityAddTraits(.isHeader)
    }
}

struct EmptyStateView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    let text: String
    var systemImage = "checkmark.seal"
    var allowsAdd = false

    var body: some View {
        VStack(spacing: 18) {
            ZStack {
                Circle().stroke(Color.secondary.opacity(0.6), style: StrokeStyle(lineWidth: 2.2, lineCap: .round, dash: [0.1, 6.4]))
                    .frame(width: 104, height: 104)
                Circle().fill(accent).frame(width: 48, height: 48)
                Image(systemName: systemImage).font(.system(size: 19, weight: .semibold)).foregroundStyle(.white)
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
                Button { model.focusQuickAdd() } label: { Label(L10n.tr("记下一件事"), systemImage: "plus") }
                    .buttonStyle(CueButtonStyle()).disabled(!model.canWrite)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 34)
        .transition(Theme.reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.94)))
    }
}

struct TodayListView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel

    private var sections: [(TodaySection, [TodayItem])] {
        [TodaySection.overdue, .must, .scheduled].compactMap { s in
            let items = model.today.items.filter { $0.section == s && $0.task.status == .todo }
            return items.isEmpty ? nil : (s, items)
        }
    }

    var body: some View {
        if model.today.date.isEmpty && (model.connectionState == .connecting || model.isLoading) {
            LoadingTasksView()
        } else if model.connectionState == .noRuntime && model.today.date.isEmpty {
            EmptyStateView(text: L10n.tr("连接后，任务会显示在这里"), systemImage: "tray")
        } else if sections.isEmpty && model.next?.next == nil {
            EmptyStateView(text: model.today.completed.isEmpty ? L10n.tr("从一件小事开始\n记下来，就不用一直惦记。") : L10n.tr("今天已清空\n完成了 \(model.today.completed.count) 件事，留点时间给自己。"), systemImage: model.today.completed.isEmpty ? "plus" : "checkmark", allowsAdd: true)
        } else {
            ForEach(sections, id: \.0) { section, items in
                VStack(spacing: 2) {
                    let group = "\(model.today.date):\(section.rawValue)"
                    DraggableSectionHeader(title: section.label, count: items.count, view: .today, group: group, firstId: items.first?.task.id, color: section == .overdue ? Theme.overdue : .secondary)
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        DraggableTaskRow(task: item.task, surface: .list(.today), group: group, nextId: index + 1 < items.count ? items[index + 1].task.id : nil, reasons: item.reasons)
                    }
                    TaskGroupEnd(view: .today, group: group)
                }
                .zIndex(model.dragPresentation?.source.group == "\(model.today.date):\(section.rawValue)" ? 1 : 0)
            }
        }
    }
}

struct UpcomingListView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel

    private var groups: [(String, [TodoTask])] {
        let dict = Dictionary(grouping: model.upcoming) { $0.planDate ?? "" }
        return dict.keys.sorted().map { ($0, dict[$0]!) }
    }

    var body: some View {
        if groups.isEmpty {
            EmptyStateView(text: L10n.tr("没有即将到来的任务"), systemImage: "calendar")
        } else {
            ForEach(groups, id: \.0) { date, tasks in
                VStack(spacing: 2) {
                    DraggableSectionHeader(title: TCDate.dateLabel(date), count: tasks.count, view: .upcoming, group: date, firstId: tasks.first?.id)
                    ForEach(Array(tasks.enumerated()), id: \.element.id) { index, task in
                        DraggableTaskRow(task: task, surface: .list(.upcoming), group: date, nextId: index + 1 < tasks.count ? tasks[index + 1].id : nil)
                    }
                    TaskGroupEnd(view: .upcoming, group: date)
                }
                .zIndex(model.dragPresentation?.source.group == date ? 1 : 0)
            }
        }
    }
}

struct AllListView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @State private var query = ""

    private var groups: [(String, [TodoTask])] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let tasks = model.allTasks.filter { term.isEmpty || [$0.title, $0.project ?? "", $0.notes ?? ""].contains { $0.localizedStandardContains(term) } }
        let dict = Dictionary(grouping: tasks) { $0.project ?? "" }
        let keys = Set(dict.keys).union(term.isEmpty && !tasks.isEmpty ? [""] : []).sorted { a, b in
            if a.isEmpty != b.isEmpty { return b.isEmpty } // named projects first
            return a < b
        }
        return keys.map { ($0, dict[$0] ?? []) }
    }

    var body: some View {
        SearchField(query: $query, placeholder: L10n.tr("搜索任务、项目或备注"), label: L10n.tr("搜索任务"))
        if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Text(L10n.tr("清除搜索后可拖动调整顺序")).font(.system(size: 11)).foregroundStyle(.secondary).padding(.horizontal, 4)
        }
        if groups.isEmpty {
            EmptyStateView(text: query.isEmpty ? L10n.tr("所有事情，都已妥当\n有新想法时，随时记下来。") : L10n.tr("没有找到相关任务\n试试其他关键词。"), systemImage: query.isEmpty ? "tray" : "magnifyingglass", allowsAdd: query.isEmpty)
        } else {
            ForEach(groups, id: \.0) { project, tasks in
                VStack(spacing: 2) {
                    let enabled = query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    DraggableSectionHeader(title: project.isEmpty ? L10n.tr("未分组") : project, count: tasks.count, view: .all, group: project, firstId: tasks.first?.id, enabled: enabled)
                    ForEach(Array(tasks.enumerated()), id: \.element.id) { index, task in
                        DraggableTaskRow(task: task, surface: .list(.all), group: project, nextId: index + 1 < tasks.count ? tasks[index + 1].id : nil, enabled: enabled, showProject: false, compact: true)
                    }
                    TaskGroupEnd(view: .all, group: project, enabled: enabled)
                }
                .zIndex(model.dragPresentation?.source.group == project ? 1 : 0)
            }
        }
    }
}

struct QuickAddView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    @Environment(\.colorScheme) private var scheme
    /// nil adds to today; the calendar passes the day the reader is looking at.
    var date: String? = nil
    @FocusState private var focused: Bool
    private var hasText: Bool { !model.quickAddText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var isToday: Bool { date == nil || date == TCDate.todayString() }
    private var prompt: String { isToday ? L10n.tr("添加到今天…") : L10n.tr("添加到 \(TCDate.dateLabel(date!))…") }
    private var dayLabel: String { isToday ? L10n.tr("今天") : TCDate.dateLabel(date!) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                // The disc is the whole affordance: it focuses the field, turns orange while you
                // type and becomes the send button once there is something to send.
                Button {
                    if hasText { model.quickAdd(on: date) } else { focused = true }
                } label: {
                    ZStack {
                        Circle().fill(focused || hasText ? accent : idleDisc)
                        // Two glyphs that trade places, so the plus can turn on focus without the
                        // arrow inheriting its rotation when text arrives.
                        if hasText {
                            Image(systemName: "arrow.up")
                                .transition(.scale(scale: 0.4).combined(with: .opacity))
                        } else {
                            Image(systemName: "plus")
                                .rotationEffect(.degrees(focused && !Theme.reduceMotion ? 90 : 0))
                                .transition(.scale(scale: 0.4).combined(with: .opacity))
                        }
                    }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 42, height: 42)
                    .scaleEffect(model.isQuickAdding && !Theme.reduceMotion ? 0.9 : 1)
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(!model.canWrite || model.isQuickAdding)
                .accessibilityLabel(hasText ? L10n.tr("添加到 \(dayLabel)") : L10n.tr("快速添加到 \(dayLabel)"))
                .help(hasText ? L10n.tr("回车添加") : prompt)
                TextField(prompt, text: $model.quickAddText,
                          prompt: Text(prompt).foregroundColor(.secondary))
                    .textFieldStyle(.plain).font(.system(size: 13))
                    .focused($focused).onSubmit { model.quickAdd(on: date) }
                    .disabled(!model.canWrite || model.isQuickAdding)
                    .accessibilityLabel(L10n.tr("快速添加到 \(dayLabel)"))
                if model.isQuickAdding { ProgressView().controlSize(.small) }
                else if !hasText {
                    Button(action: expand) { Image(systemName: "square.and.pencil") }
                        .buttonStyle(QuietIconButtonStyle()).foregroundStyle(.secondary)
                        .accessibilityLabel(model.savedDraft == nil ? L10n.tr("展开完整表单") : L10n.tr("继续草稿"))
                        .help(model.savedDraft == nil ? L10n.tr("展开完整表单（⌘N）") : L10n.tr("继续未保存的草稿"))
                        .disabled(!model.canWrite)
                }
            }
            if focused || hasText {
                HStack {
                    Label(dayLabel, systemImage: "calendar").foregroundStyle(.secondary)
                    Spacer()
                    Button(L10n.tr("添加详情"), action: expand).buttonStyle(.plain).foregroundStyle(accent)
                        .disabled(!model.canWrite || model.isQuickAdding)
                    Text("↵").font(.system(size: 12)).foregroundStyle(.tertiary).accessibilityHidden(true)
                }
                .font(.system(size: 11))
                .padding(.leading, 56).padding(.trailing, 6).padding(.bottom, 4)
                .transition(.opacity.combined(with: .offset(y: -4)))
            }
        }
        .padding(.leading, 8).padding(.trailing, 10).padding(.vertical, 8)
        .dialTile(.frost, radius: 29)
        .overlay(RoundedRectangle(cornerRadius: 29, style: .continuous)
            .strokeBorder(accent.opacity(focused ? 0.6 : 0), lineWidth: 1).allowsHitTesting(false))
        .animation(Dial.snap, value: focused)
        .animation(Dial.snap, value: hasText)
        .animation(Dial.pop, value: model.isQuickAdding)
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

    private var idleDisc: Color { scheme == .dark ? Color.white.opacity(0.16) : Dial.graphite(.light) }

    private func expand() {
        model.expandQuickAdd(on: date)
    }
}

struct CompletedTodayView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @Binding var expanded: Bool

    var body: some View {
        VStack(spacing: 5) {
            Divider().opacity(0.4).padding(.bottom, 6)
            Button { withAnimation(Theme.listChange) { expanded.toggle() } } label: {
                HStack(spacing: 7) {
                    Image(systemName: "chevron.right").rotationEffect(.degrees(expanded ? 90 : 0))
                        .font(.system(size: 9, weight: .semibold))
                    Text(L10n.tr("今日已完成")).font(.system(size: 12, weight: .medium))
                    Text("\(model.today.completed.count)").font(.system(size: 12)).monospacedDigit()
                    Spacer()
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
                .padding(.vertical, 7)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(expanded ? L10n.tr("收起今日已完成") : L10n.tr("展开今日已完成"))
            .overlay(alignment: .trailing) {
                // This section only ever holds today; the full history is one tap from here.
                Button(L10n.tr("查看全部"), action: model.showCompleted)
                    .buttonStyle(.plain).font(.system(size: 11))
                    .foregroundStyle(.secondary).padding(.horizontal, 4)
            }
            if expanded {
                ForEach(model.today.completed) { task in TaskRowView(task: task) }
            }
        }
    }
}

private struct LoadingTasksView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @State private var breathing = false
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
        .opacity(breathing ? 0.45 : 1)
        .onAppear {
            guard !Theme.reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { breathing = true }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L10n.tr("正在加载任务"))
    }
}
