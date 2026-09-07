import SwiftUI
import TodoCueKit

/// Shared state between the notch controller and its SwiftUI content.
@MainActor
final class NotchState: ObservableObject {
    @Published var expanded = false
    @Published var notchWidth: CGFloat = 180
    @Published var notchHeight: CGFloat = 32
    @Published var reduceMotion = false
    var contentSize: CGSize = .zero
    var onOpenTask: ((String) -> Void)?
    var onOpenAll: (() -> Void)?
    var onContentSize: ((CGSize) -> Void)?
}

private struct SizeKey: PreferenceKey {
    static var defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}

/// Black shape merging with the notch; content drawn below the camera area.
struct NotchRootView: View {
    @ObservedObject var state: NotchState
    @ObservedObject var model: AppModel

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                NotchShape(notchWidth: state.notchWidth + 20, notchHeight: state.notchHeight, expanded: state.expanded)
                    .fill(Color.black)
                    .overlay(
                        NotchShape(notchWidth: state.notchWidth + 20, notchHeight: state.notchHeight, expanded: state.expanded)
                            .stroke(Color.white.opacity(state.expanded ? 0.08 : 0), lineWidth: 0.5)
                    )
                if state.expanded {
                    content
                        .padding(.top, state.notchHeight + 6)
                        .padding(.horizontal, 14)
                        .padding(.bottom, 12)
                        .frame(width: geo.size.width, alignment: .top)
                        .background(GeometryReader { g in Color.clear.preference(key: SizeKey.self, value: g.size) })
                        .transition(state.reduceMotion ? .opacity : .opacity.combined(with: .offset(y: -8)))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
        }
        .onPreferenceChange(SizeKey.self) { size in
            let adjusted = CGSize(width: size.width, height: size.height - state.notchHeight)
            if adjusted != state.contentSize {
                state.contentSize = adjusted
                state.onContentSize?(adjusted)
            }
        }
        .animation(state.reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.32, dampingFraction: 0.86), value: state.expanded)
        .preferredColorScheme(.dark)
        .environment(\.accent, Theme.accent(.dark))
        .tint(Theme.accent(.dark))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("TodoCue 刘海快览")
    }

    private var items: [TodayItem] {
        Array(model.today.items.filter { $0.task.status == .todo && $0.task.id != model.next?.next?.task.id }
            .prefix(model.next?.next == nil ? 3 : 2))
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center) {
                CueMark().scaleEffect(0.8).frame(width: 16, height: 16)
                Text("今日剩余")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.white.opacity(0.65))
                Text("\(model.remaining)")
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                    .contentTransition(.numericText())
                Spacer()
                if !model.connectionState.isOnline {
                    Label("离线", systemImage: "wifi.slash")
                        .font(.system(size: 11))
                        .foregroundStyle(.orange)
                }
                Button("查看全部") { state.onOpenAll?() }
                    .buttonStyle(.plain)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.accent(.dark))
                    .accessibilityLabel("查看全部今日任务")
            }
            if let next = model.next?.next {
                NotchNextRow(candidate: next, model: model, state: state)
            }
            if items.isEmpty && model.next?.next == nil {
                Text(model.connectionState == .noRuntime ? "运行时未启动" : "今天没有待办")
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.7))
                    .padding(.vertical, 6)
            } else {
                VStack(spacing: 2) {
                    ForEach(items) { item in
                        NotchTaskRow(item: item, model: model, state: state)
                    }
                }
            }
        }
    }
}

private struct NotchNextRow: View {
    let candidate: NextCandidate
    @ObservedObject var model: AppModel
    @ObservedObject var state: NotchState

    var body: some View {
        Button { state.onOpenTask?(candidate.task.id) } label: {
            HStack(spacing: 8) {
                Image(systemName: "arrow.forward.circle.fill")
                    .foregroundStyle(Theme.accent(.dark))
                VStack(alignment: .leading, spacing: 1) {
                    Text(candidate.task.title)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Text(TaskMeta.line(for: candidate.task, includeProject: true))
                        .font(.system(size: 11))
                        .foregroundStyle(.white.opacity(0.6))
                        .lineLimit(1)
                }
                Spacer()
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(0.08)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("下一项：\(candidate.task.title)")
    }
}

private struct NotchTaskRow: View {
    let item: TodayItem
    @ObservedObject var model: AppModel
    @ObservedObject var state: NotchState

    var body: some View {
        HStack(spacing: 8) {
            CheckButton(task: item.task).environmentObject(model)

            Button { state.onOpenTask?(item.task.id) } label: {
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.task.title)
                        .font(.system(size: 13))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Text(TaskMeta.line(for: item.task, includeProject: true))
                        .font(.system(size: 11))
                        .foregroundStyle(item.section == .overdue ? .red : .white.opacity(0.55))
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("打开 \(item.task.title)")

            if item.task.hasReminder {
                Button { model.snooze(item.task) } label: {
                    Image(systemName: "zzz")
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.6))
                }
                .buttonStyle(.plain)
                .disabled(!model.canWrite)
                .help("10 分钟后提醒")
                .accessibilityLabel("稍后提醒 \(item.task.title)")
            }
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 6)
    }
}

/// Rounded black shape: a bar around the notch when collapsed, a drop-down card when expanded.
struct NotchShape: Shape {
    var notchWidth: CGFloat
    var notchHeight: CGFloat
    var expanded: Bool

    func path(in rect: CGRect) -> Path {
        var p = Path()
        if !expanded {
            let r: CGFloat = 8
            let w = min(notchWidth, rect.width)
            let x = rect.midX - w / 2
            p.move(to: CGPoint(x: x, y: 0))
            p.addLine(to: CGPoint(x: x + w, y: 0))
            p.addLine(to: CGPoint(x: x + w, y: notchHeight - r))
            p.addQuadCurve(to: CGPoint(x: x + w - r, y: notchHeight), control: CGPoint(x: x + w, y: notchHeight))
            p.addLine(to: CGPoint(x: x + r, y: notchHeight))
            p.addQuadCurve(to: CGPoint(x: x, y: notchHeight - r), control: CGPoint(x: x, y: notchHeight))
            p.closeSubpath()
        } else {
            let r: CGFloat = 18
            p.move(to: CGPoint(x: 0, y: 0))
            p.addLine(to: CGPoint(x: rect.width, y: 0))
            p.addLine(to: CGPoint(x: rect.width, y: rect.height - r))
            p.addArc(center: CGPoint(x: rect.width - r, y: rect.height - r), radius: r, startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
            p.addLine(to: CGPoint(x: r, y: rect.height))
            p.addArc(center: CGPoint(x: r, y: rect.height - r), radius: r, startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
            p.closeSubpath()
        }
        return p
    }
}
