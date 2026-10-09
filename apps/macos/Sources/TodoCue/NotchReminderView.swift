import TodoCueKit
import SwiftUI

struct NotchReminderView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    let cue: ReminderCue
    @ObservedObject var state: NotchState
    @ObservedObject var model: AppModel
    @State private var arrivedAt = Date()
    private let signal = Dial.orange

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 13) {
                TimelineView(.animation(minimumInterval: 1 / 30, paused: state.reduceMotion)) { context in
                    let pose = CueMotion.pose(at: context.date.timeIntervalSince(arrivedAt), reduceMotion: state.reduceMotion)
                    let elapsed = context.date.timeIntervalSince(arrivedAt)
                    ZStack {
                        // Two rings leave the disc as the Cue lands, then it rests.
                        ForEach(0..<2, id: \.self) { ring in
                            let p = CueMotion.ripple(at: elapsed - Double(ring) * 0.32, reduceMotion: state.reduceMotion)
                            Circle().stroke(signal, lineWidth: 1.5)
                                .frame(width: 46, height: 46)
                                .scaleEffect(1 + 0.55 * p)
                                .opacity(p > 0 && p < 1 ? 0.55 * (1 - p) : 0)
                        }
                        Circle().fill(signal).frame(width: 46, height: 46)
                        CueMark().environment(\.accent, .white).scaleEffect(1.1)
                            .scaleEffect(x: pose.scaleX, y: pose.scaleY).rotationEffect(.degrees(pose.rotation)).offset(y: pose.offsetY)
                    }
                }.frame(width: 48, height: 48).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 5) {
                        Text(L10n.tr("轻轻 Cue 你一下")).font(.system(size: 12, weight: .semibold)).foregroundStyle(signal)
                        if cue.late { Text(L10n.tr("· 刚才错过了")).font(.system(size: 11)).foregroundStyle(.white.opacity(0.5)) }
                    }
                    Button { state.onCueOpen?() } label: {
                        Text(cue.task.title).font(.system(size: 18, weight: .semibold)).tracking(-0.3)
                            .foregroundStyle(.white).lineLimit(2).multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel(L10n.tr("打开提醒任务 \(cue.task.title)"))
                    if cue.count > 1 {
                        Text(L10n.tr("还有 \(cue.count - 1) 件事等你，点开看看。")) .font(.system(size: 11)).foregroundStyle(.white.opacity(0.6))
                    } else if let project = cue.task.project, !project.isEmpty {
                        Text(project).font(.system(size: 11)).foregroundStyle(.white.opacity(0.5)).lineLimit(1)
                    }
                }
                Button { state.onCueDismiss?() } label: { Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)) }
                    .buttonStyle(QuietIconButtonStyle()).foregroundStyle(.white.opacity(0.5))
                    .accessibilityLabel(L10n.tr("收起这条 Cue 提醒"))
            }
            HStack(spacing: 8) {
                Button { state.onCueComplete?() } label: { Label(L10n.tr("完成啦"), systemImage: "checkmark") }
                    .buttonStyle(CueButtonStyle(prominent: true)).accessibilityLabel(L10n.tr("完成提醒任务"))
                Button { state.onCueSnooze?() } label: { Label(L10n.tr("10 分钟后"), systemImage: "zzz") }
                    .buttonStyle(CueButtonStyle()).accessibilityLabel(L10n.tr("Cue 提醒延后 10 分钟"))
                Spacer(minLength: 0)
                if state.cueBusy { ProgressView().controlSize(.small) }
                else { Text("TodoCue").font(Dial.numeral(9.5)).foregroundStyle(.white.opacity(0.35)) }
            }.disabled(!model.canWrite || state.cueBusy)
            if let error = state.cueError { Text(error).font(.system(size: 11)).foregroundStyle(.orange).lineLimit(2) }
        }
        .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 18)
        .onHover { state.cueHovered = $0 }
        .onAppear { arrivedAt = Date() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.tr("TodoCue 提醒：\(cue.task.title)"))
    }
}
