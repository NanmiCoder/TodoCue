import SwiftUI

struct NotchReminderView: View {
    let cue: ReminderCue
    @ObservedObject var state: NotchState
    @ObservedObject var model: AppModel
    @State private var arrivedAt = Date()
    private let mint = Theme.accent(.dark)

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 13) {
                TimelineView(.animation(minimumInterval: 1 / 30, paused: state.reduceMotion)) { context in
                    let pose = CueMotion.pose(at: context.date.timeIntervalSince(arrivedAt), reduceMotion: state.reduceMotion)
                    ZStack {
                        Circle().fill(mint.opacity(0.13)).frame(width: 46, height: 46)
                        CueMark().scaleEffect(1.1)
                    }
                    .scaleEffect(x: pose.scaleX, y: pose.scaleY).rotationEffect(.degrees(pose.rotation)).offset(y: pose.offsetY)
                }.frame(width: 48, height: 48).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 5) {
                        Text("轻轻 Cue 你一下").font(.system(size: 12, weight: .semibold)).foregroundStyle(mint)
                        if cue.late { Text("· 刚才错过了").font(.system(size: 11)).foregroundStyle(.white.opacity(0.5)) }
                    }
                    Button { state.onCueOpen?() } label: {
                        Text(cue.task.title).font(.system(size: 18, weight: .semibold)).tracking(-0.3)
                            .foregroundStyle(.white).lineLimit(2).multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel("打开提醒任务 \(cue.task.title)")
                    if cue.count > 1 {
                        Text("还有 \(cue.count - 1) 件事等你，点开看看。") .font(.system(size: 11)).foregroundStyle(.white.opacity(0.6))
                    } else if let project = cue.task.project, !project.isEmpty {
                        Text(project).font(.system(size: 11)).foregroundStyle(.white.opacity(0.5)).lineLimit(1)
                    }
                }
                Button { state.onCueDismiss?() } label: { Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)) }
                    .buttonStyle(QuietIconButtonStyle()).foregroundStyle(.white.opacity(0.5))
                    .accessibilityLabel("收起这条 Cue 提醒")
            }
            HStack(spacing: 8) {
                Button { state.onCueComplete?() } label: { Label("完成啦", systemImage: "checkmark") }
                    .buttonStyle(CueButtonStyle(prominent: true)).accessibilityLabel("完成提醒任务")
                Button { state.onCueSnooze?() } label: { Label("10 分钟后", systemImage: "zzz") }
                    .buttonStyle(CueButtonStyle()).accessibilityLabel("Cue 提醒延后 10 分钟")
                Spacer(minLength: 0)
                if state.cueBusy { ProgressView().controlSize(.small) }
                else { Text("TodoCue").font(.system(size: 10, weight: .medium)).tracking(0.5).foregroundStyle(.white.opacity(0.3)) }
            }.disabled(!model.canWrite || state.cueBusy)
            if let error = state.cueError { Text(error).font(.system(size: 11)).foregroundStyle(.orange).lineLimit(2) }
        }
        .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 18)
        .onHover { state.cueHovered = $0 }
        .onAppear { arrivedAt = Date() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("TodoCue 提醒：\(cue.task.title)")
    }
}
