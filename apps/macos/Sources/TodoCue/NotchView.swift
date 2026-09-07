import SwiftUI
import TodoCueKit

/// Shared state between the notch controller and its SwiftUI content.
@MainActor
final class NotchState: ObservableObject {
    @Published var expanded = false
    /// Stays open until Esc, a click outside or the pin button; hovering alone never pins.
    @Published var pinned = false
    @Published var editing = false
    @Published var notchWidth: CGFloat = 180
    @Published var notchHeight: CGFloat = 32
    @Published var slack: CGFloat = Theme.notchSlack
    /// Width of the summary wing on each side of the notch; 0 hides the wings.
    @Published var wingWidth: CGFloat = 0
    @Published var reduceMotion = false
    @Published var quickAddText = ""
    @Published var focusRequest = 0
    private(set) var contentSize: CGSize = .zero

    var onOpenTask: ((String) -> Void)?
    var onOpenAll: (() -> Void)?
    var onNewTask: (() -> Void)?
    var onTogglePin: (() -> Void)?
    var onCollapse: (() -> Void)?
    var onEditingChanged: ((Bool) -> Void)?
    var onContentSize: ((CGSize) -> Void)?

    func report(contentSize size: CGSize) {
        guard size != contentSize else { return }
        contentSize = size
        onContentSize?(size)
    }
}

/// Black shell merged with the notch. The card keeps a fixed width and its ideal height, so its
/// measurement never depends on the window size that is derived from it.
struct NotchRootView: View {
    @ObservedObject var state: NotchState
    @ObservedObject var model: AppModel

    private var corner: CGFloat { state.expanded ? Theme.notchCorner : Theme.notchCollapsedCorner }

    var body: some View {
        ZStack(alignment: .top) {
            NotchShape(corner: corner).fill(Color.black)
            NotchShape(corner: corner).stroke(Color.white.opacity(state.expanded ? 0.12 : 0), lineWidth: 1)
            if !state.expanded && state.wingWidth > 0 {
                NotchSummaryView(state: state, model: model).transition(.opacity)
            }
            NotchCardView(state: state, model: model)
                .frame(width: Theme.notchExpandedWidth)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGSize.self, of: { $0.size }, action: { state.report(contentSize: $0) })
                .padding(.top, state.notchHeight)
                .opacity(state.expanded ? 1 : 0)
                .allowsHitTesting(state.expanded)
                .accessibilityHidden(!state.expanded)
        }
        // Explicit minimums keep the shell at the window size; the card overflows downward until the window grows.
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .top)
        .clipShape(NotchShape(corner: corner))
        .animation(state.reduceMotion ? .easeInOut(duration: 0.15) : Theme.expand, value: state.expanded)
        .environmentObject(model)
        .preferredColorScheme(.dark)
        .environment(\.accent, Theme.accent(.dark))
        .tint(Theme.accent(.dark))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("TodoCue 刘海快览")
    }
}

/// Collapsed wings: the cue mark on the left, today's remaining count (or the offline mark) on the right.
private struct NotchSummaryView: View {
    @ObservedObject var state: NotchState
    @ObservedObject var model: AppModel

    var body: some View {
        HStack(spacing: 0) {
            CueMark().scaleEffect(0.72).frame(width: state.wingWidth)
            Color.clear.frame(width: state.notchWidth + 2 * state.slack)
            Group {
                if model.connectionState.isOnline {
                    Text("\(model.remaining)")
                        .font(.system(size: 13, weight: .semibold, design: .rounded)).monospacedDigit()
                        .foregroundStyle(.white)
                        .contentTransition(.numericText())
                } else {
                    Image(systemName: "wifi.slash").font(.system(size: 11, weight: .semibold)).foregroundStyle(.orange)
                }
            }
            .frame(width: state.wingWidth)
        }
        .frame(height: state.notchHeight)
        .animation(Theme.interaction, value: model.remaining)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.connectionState.isOnline ? "今日剩余 \(model.remaining) 项，悬停或点击展开" : "TodoCue 离线")
    }
}

/// The drop-down card: header, next step, today's rows, quick add.
private struct NotchCardView: View {
    @ObservedObject var state: NotchState
    @ObservedObject var model: AppModel

    private var nextId: String? { model.next?.next?.task.id }
    private var selection: NotchLayout.Selection {
        NotchLayout.select(items: model.today.items, nextId: nextId, limit: Theme.notchMaxRows)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            NotchHeader(state: state, model: model)
                .opacity(model.toast == nil ? 1 : 0)
                .accessibilityHidden(model.toast != nil)
            if model.connectionState == .noRuntime {
                NotchNotice(icon: "bolt.slash", text: "未找到 TodoCue 运行时", action: "重试") { model.reconnect() }
            } else if !model.connectionState.isOnline {
                NotchNotice(icon: "wifi.slash", text: model.connectionState.label + "，显示上次数据", action: "重连") { model.reconnect() }
            }
            if let next = model.next?.next {
                NotchNextCard(candidate: next, state: state)
            }
            if selection.rows.isEmpty && model.next?.next == nil {
                if model.connectionState != .noRuntime { NotchEmptyView(model: model) }
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(selection.groups, id: \.section) { group in
                        NotchSectionLabel(section: group.section, count: group.items.count)
                        ForEach(group.items) { item in
                            NotchTaskRow(item: item, state: state)
                        }
                    }
                    if selection.hidden > 0 {
                        Button { state.onOpenAll?() } label: {
                            Text("还有 \(selection.hidden) 项，查看全部")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(.white.opacity(0.6))
                                .padding(.horizontal, 8).padding(.vertical, 6)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("还有 \(selection.hidden) 项，打开面板查看全部")
                    }
                }
            }
            NotchFooter(state: state, model: model)
        }
        .padding(.top, 8).padding(.horizontal, 16).padding(.bottom, 16)
        // Feedback drops out from under the notch in place of the header, never over the rows or the input.
        .overlay(alignment: .top) {
            if let toast = model.toast {
                ToastView(toast: toast)
                    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color(white: 0.13)).padding(.horizontal, 16))
                    .padding(.top, 7)
                    .transition(state.reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(Theme.interaction, value: model.toast)
    }
}

private struct NotchHeader: View {
    @ObservedObject var state: NotchState
    @ObservedObject var model: AppModel
    @Environment(\.accent) private var accent

    var body: some View {
        HStack(spacing: 10) {
            CueMark()
            VStack(alignment: .leading, spacing: 1) {
                Text("今天").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                Text(model.todayDateLabel).font(.system(size: 11)).foregroundStyle(.white.opacity(0.55))
            }
            Spacer(minLength: 8)
            DayProgressView(completed: model.today.completed.count, remaining: model.remaining)
            Button { state.onNewTask?() } label: { Image(systemName: "plus") }
                .buttonStyle(QuietIconButtonStyle())
                .foregroundStyle(.white.opacity(0.75))
                .disabled(!model.canWrite)
                .help("新建任务（在面板中填写详情）")
                .accessibilityLabel("新建任务")
            Button { state.onTogglePin?() } label: { Image(systemName: state.pinned ? "pin.fill" : "pin") }
                .buttonStyle(QuietIconButtonStyle())
                .foregroundStyle(state.pinned ? accent : .white.opacity(0.55))
                .help(state.pinned ? "取消固定，移开鼠标即收起" : "固定快览，移开鼠标也保持展开")
                .accessibilityLabel(state.pinned ? "取消固定快览" : "固定快览")
        }
        .padding(.horizontal, 2)
    }
}

private struct NotchNotice: View {
    let icon: String
    let text: String
    let action: String
    let perform: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon).foregroundStyle(.orange)
            Text(text).font(.system(size: 12)).foregroundStyle(.white.opacity(0.85)).lineLimit(1)
            Spacer()
            Button(action, action: perform).buttonStyle(CueButtonStyle())
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color.orange.opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}

private struct NotchNextCard: View {
    @EnvironmentObject var model: AppModel
    let candidate: NextCandidate
    @ObservedObject var state: NotchState
    @Environment(\.accent) private var accent
    @State private var hovered = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let countdown = NotchLayout.countdown(for: candidate.task, now: context.date)
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Circle().fill(accent).frame(width: 5, height: 5)
                    Text("下一步").font(.system(size: 11, weight: .semibold)).foregroundStyle(accent)
                    Spacer(minLength: 4)
                    Text(countdown?.text ?? candidate.group.label)
                        .font(.system(size: 11, weight: .medium)).monospacedDigit()
                        .foregroundStyle(countdown?.late == true || candidate.task.isOverdue ? Theme.overdue : .white.opacity(0.6))
                        .contentTransition(.numericText())
                }
                Button { state.onOpenTask?(candidate.task.id) } label: {
                    Text(candidate.task.title)
                        .font(.system(size: 17, weight: .semibold)).tracking(-0.3)
                        .foregroundStyle(.white)
                        .lineLimit(2).multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("打开 \(candidate.task.title)")
                TaskMetadataView(task: candidate.task, emphasized: true)
                HStack(spacing: 8) {
                    Button { model.complete(candidate.task) } label: { Label("完成", systemImage: "checkmark") }
                        .buttonStyle(CueButtonStyle(prominent: true))
                        .disabled(!model.canWrite || model.completingTaskIDs.contains(candidate.task.id))
                        .accessibilityLabel("完成 \(candidate.task.title)")
                    Button { model.snooze(candidate.task) } label: { Label("10 分钟后提醒", systemImage: "zzz") }
                        .buttonStyle(CueButtonStyle())
                        .disabled(!model.canWrite)
                        .accessibilityLabel("10 分钟后提醒 \(candidate.task.title)")
                    Button { model.moveToTomorrow(candidate.task) } label: { Label("明天", systemImage: "arrow.turn.down.right") }
                        .buttonStyle(CueButtonStyle())
                        .disabled(!model.canWrite)
                        .accessibilityLabel("把 \(candidate.task.title) 改期到明天")
                    Spacer()
                    Button { state.onOpenTask?(candidate.task.id) } label: {
                        Image(systemName: "chevron.right").foregroundStyle(accent)
                    }
                    .buttonStyle(QuietIconButtonStyle())
                    .accessibilityLabel("查看下一步详情")
                }
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(accent.opacity(hovered ? 0.14 : 0.10)))
            .overlay(alignment: .leading) {
                Capsule().fill(accent.opacity(0.6)).frame(width: 2, height: 24).padding(.leading, -1)
            }
            .onHover { hovered = $0 }
            .animation(Theme.interaction, value: hovered)
        }
    }
}

private struct NotchSectionLabel: View {
    let section: TodaySection
    let count: Int

    var body: some View {
        HStack(spacing: 6) {
            Text(section.label).font(.system(size: 11, weight: .semibold))
                .foregroundStyle(section == .overdue ? Theme.overdue : .white.opacity(0.5))
            Text("\(count)").font(.system(size: 11, weight: .medium)).monospacedDigit().foregroundStyle(.white.opacity(0.4))
            Spacer()
        }
        .padding(.horizontal, 6).padding(.top, 6).padding(.bottom, 2)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

private struct NotchTaskRow: View {
    @EnvironmentObject var model: AppModel
    let item: TodayItem
    @ObservedObject var state: NotchState
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 6) {
            CheckButton(task: item.task)
            Button { state.onOpenTask?(item.task.id) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.task.title)
                        .font(.system(size: 13, weight: .medium)).foregroundStyle(.white).lineLimit(1)
                    let meta = TaskMeta.line(for: item.task)
                    if !meta.isEmpty {
                        Text(meta).font(.system(size: 11))
                            .foregroundStyle(item.task.isOverdue || item.section == .overdue ? Theme.overdue : .white.opacity(0.55))
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("打开 \(item.task.title)")
            if item.task.priority == .high {
                Image(systemName: "flag.fill").font(.system(size: 10)).foregroundStyle(.red).accessibilityLabel("高优先级")
            }
            HStack(spacing: 0) {
                Button { model.snooze(item.task) } label: { Image(systemName: "zzz") }
                    .buttonStyle(QuietIconButtonStyle())
                    .help("10 分钟后提醒")
                    .accessibilityLabel("10 分钟后提醒 \(item.task.title)")
                Button { model.moveToTomorrow(item.task) } label: { Image(systemName: "arrow.turn.down.right") }
                    .buttonStyle(QuietIconButtonStyle())
                    .help("改期到明天")
                    .accessibilityLabel("把 \(item.task.title) 改期到明天")
            }
            .foregroundStyle(.white.opacity(0.7))
            .opacity(hovering ? 1 : 0)
            .disabled(!model.canWrite)
        }
        .padding(.vertical, 2).padding(.horizontal, 4)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(hovering ? 0.07 : 0)))
        .onHover { hovering = $0 }
        .animation(Theme.interaction, value: hovering)
        .contextMenu { TaskContextMenu(task: item.task) }
    }
}

private struct NotchEmptyView: View {
    @ObservedObject var model: AppModel
    @Environment(\.accent) private var accent

    private var cleared: Bool { !model.today.completed.isEmpty }

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(accent.opacity(0.10)).frame(width: 36, height: 36)
                Image(systemName: cleared ? "checkmark" : "plus").font(.system(size: 15, weight: .medium)).foregroundStyle(accent)
            }
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(cleared ? "今天已清空" : "今天还没有安排")
                    .font(.system(size: 14, weight: .medium)).foregroundStyle(.white)
                Text(cleared ? "完成了 \(model.today.completed.count) 件事，留点时间给自己。" : "在下方记一件事，回车就加到今天。")
                    .font(.system(size: 11)).foregroundStyle(.white.opacity(0.55))
            }
            Spacer()
        }
        .padding(.vertical, 8).padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
    }
}

/// Quick add straight from the notch; typing pins the card until Esc or a click outside.
private struct NotchFooter: View {
    @ObservedObject var state: NotchState
    @ObservedObject var model: AppModel
    @Environment(\.accent) private var accent
    @FocusState private var focused: Bool

    private var hasText: Bool { !state.quickAddText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "plus").font(.system(size: 14, weight: .medium)).foregroundStyle(accent).accessibilityHidden(true)
                TextField("添加到今天", text: $state.quickAddText,
                          prompt: Text("添加到今天，回车创建").foregroundColor(.white.opacity(0.4)))
                    .textFieldStyle(.plain).font(.system(size: 13)).foregroundStyle(.white)
                    .focused($focused)
                    .onSubmit(submit)
                    .disabled(!model.canWrite || model.isQuickAdding)
                    .accessibilityLabel("快速添加到今天")
                if model.isQuickAdding {
                    ProgressView().controlSize(.small)
                } else if hasText {
                    Button(action: submit) {
                        Image(systemName: "arrow.up.circle.fill").font(.system(size: 20)).foregroundStyle(accent)
                    }
                    .buttonStyle(.plain)
                    .disabled(!model.canWrite)
                    .accessibilityLabel("添加到今天")
                }
            }
            .padding(.horizontal, 12).frame(height: 36)
            .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(focused ? accent.opacity(0.6) : Color.white.opacity(0.10), lineWidth: focused ? 1 : 0.5))
            Button { state.onOpenAll?() } label: { Label("查看全部", systemImage: "arrow.up.right") }
                .buttonStyle(CueButtonStyle())
                .accessibilityLabel("查看全部今日任务")
        }
        .padding(.top, 4)
        .animation(Theme.interaction, value: focused)
        .onChange(of: focused) { _, on in
            state.editing = on
            state.onEditingChanged?(on)
        }
        .onChange(of: state.focusRequest) { _, _ in focused = true }
        .onChange(of: state.expanded) { _, on in if !on { focused = false } }
    }

    private func submit() {
        let text = state.quickAddText
        Task {
            guard await model.quickAdd(title: text) else { return }
            if state.quickAddText == text { state.quickAddText = "" }
            // The field was disabled while saving; give it the insertion point back once it is enabled again.
            DispatchQueue.main.async { if state.expanded { focused = true } }
        }
    }
}

/// Black bar flush with the top edge and rounded at the bottom: narrow around the notch when
/// collapsed, the whole card when expanded.
struct NotchShape: Shape {
    var corner: CGFloat
    var animatableData: CGFloat {
        get { corner }
        set { corner = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let r = max(0, min(corner, rect.width / 2, rect.height))
        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
        p.addArc(center: CGPoint(x: rect.maxX - r, y: rect.maxY - r), radius: r, startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        p.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
        p.addArc(center: CGPoint(x: rect.minX + r, y: rect.maxY - r), radius: r, startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        p.closeSubpath()
        return p
    }
}

