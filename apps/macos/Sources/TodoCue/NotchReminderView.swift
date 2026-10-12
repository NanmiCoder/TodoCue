import SwiftUI
import TodoCueKit

/// Copy shared by the full card and the rows: what kind of reminder this is and how long it has waited.
@MainActor enum CueText {
    static func meta(for entry: CueEntry, model: AppModel, now: Date = Date()) -> String {
        if let original = entry.cue.periodic {
            let rule = model.periodicReminders.first { $0.id == original.id } ?? original
            let every = L10n.tr("每 \(rule.intervalMinutes) 分钟")
            guard let waited = rule.waitingMinutes(now: now), waited > 0 else { return "\(every) · \(L10n.tr("刚刚"))" }
            return "\(every) · \(L10n.tr("已等 \(waited) 分钟"))"
        }
        if entry.cue.count > 1 { return L10n.tr("还有 \(entry.cue.count - 1) 件事等你，点开看看。") }
        guard let original = entry.cue.task else { return "" }
        let task = model.task(original.id) ?? original
        if let countdown = NotchLayout.countdown(for: task, now: now) { return "\(L10n.tr("任务提醒")) · \(countdown.text)" }
        if let project = task.project, !project.isEmpty { return project }
        return L10n.tr("任务提醒")
    }
}

/// The just-arrived reminder, drawn as a full card. Resting reminders are `CueRowView`s.
struct NotchReminderView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    let entry: CueEntry
    @ObservedObject var state: NotchState
    @ObservedObject var model: AppModel
    private let signal = Dial.orange

    private var busy: Bool { state.busyKeys.contains(entry.key) }

    var body: some View {
        let cue = entry.cue
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 13) {
                TimelineView(.animation(minimumInterval: 1 / 30, paused: state.reduceMotion)) { context in
                    let elapsed = context.date.timeIntervalSince(entry.arrivedAt)
                    let pose = CueMotion.pose(at: elapsed, reduceMotion: state.reduceMotion)
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
                        if entry.repeats > 1 { RepeatBadge(count: entry.repeats) }
                    }
                    Button { state.onCueOpen?(entry.key) } label: {
                        Text(cue.title).font(.system(size: 18, weight: .semibold)).tracking(-0.3)
                            .foregroundStyle(.white).lineLimit(2).multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel(L10n.tr("打开提醒任务 \(cue.title)"))
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        Text(CueText.meta(for: entry, model: model, now: context.date))
                            .font(.system(size: 11)).foregroundStyle(.white.opacity(0.55)).lineLimit(1)
                    }
                }
                Button { state.onStackCollapse?() } label: { Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)) }
                    .buttonStyle(QuietIconButtonStyle()).foregroundStyle(.white.opacity(0.5))
                    .help(L10n.tr("先收起，提醒仍留在刘海上"))
                    .accessibilityLabel(L10n.tr("先收起提醒，仍留在刘海上"))
            }
            HStack(spacing: 8) {
                Button { state.onCueComplete?(entry.key) } label: {
                    Label(cue.periodic == nil ? L10n.tr("完成啦") : L10n.tr("完成本次"), systemImage: "checkmark")
                }
                .buttonStyle(CueButtonStyle(prominent: true)).accessibilityLabel(L10n.tr("完成提醒任务"))
                Button { state.onCueSnooze?(entry.key) } label: { Label(L10n.tr("10 分钟后"), systemImage: "zzz") }
                    .buttonStyle(CueButtonStyle()).accessibilityLabel(L10n.tr("Cue 提醒延后 10 分钟"))
                if cue.periodic != nil {
                    Menu {
                        Button(L10n.tr("今天暂停")) { state.onCuePauseToday?(entry.key) }
                    } label: { Image(systemName: "ellipsis") }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).frame(width: 22)
                    .accessibilityLabel(L10n.tr("更多提醒操作"))
                }
                Spacer(minLength: 0)
                if busy { ProgressView().controlSize(.small) }
                else { Text("TodoCue").font(Dial.numeral(9.5)).foregroundStyle(.white.opacity(0.35)) }
            }.disabled(!model.canWrite || busy)
            if let error = state.errors[entry.key] { Text(error).font(.system(size: 11)).foregroundStyle(.orange).lineLimit(2) }
        }
        .padding(.horizontal, 6).padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.tr("TodoCue 提醒：\(cue.title)"))
    }
}

/// "×3": the same rule came round again before it was answered.
struct RepeatBadge: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    let count: Int
    var body: some View {
        Text("×\(count)")
            .font(Dial.numeral(10)).monospacedDigit()
            .foregroundStyle(Dial.orange)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(Capsule().fill(Dial.orange.opacity(0.16)))
            .accessibilityLabel(L10n.tr("已累计 \(count) 次未完成"))
    }
}
