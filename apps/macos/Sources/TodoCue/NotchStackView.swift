import SwiftUI
import TodoCueKit

/// What hangs under the notch while reminders wait: up to three rows, the newest as a full card for
/// a few seconds, the rest folded into "N more". One reminder alone rests as a single slim bar and
/// opens into the card under the pointer.
struct NotchStackView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @ObservedObject var state: NotchState
    @ObservedObject var model: AppModel

    private var entries: [CueEntry] { state.entries }
    private var visible: [CueEntry] {
        entries.enumerated().filter { $0.offset < CueStack.visibleRows || $0.element.key == state.featuredKey }.map(\.element)
    }
    private var hidden: Int { entries.count - visible.count }

    private func isFeatured(_ entry: CueEntry) -> Bool {
        entry.key == state.featuredKey || (entries.count == 1 && state.cueHovered)
    }

    var body: some View {
        VStack(spacing: 8) {
            if entries.count > 1 { header }
            VStack(spacing: 6) {
                ForEach(visible) { entry in
                    Group {
                        if isFeatured(entry) {
                            NotchReminderView(entry: entry, state: state, model: model)
                                .background(
                                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                                        .fill(Color.white.opacity(entries.count > 1 ? 0.07 : 0)))
                        } else {
                            CueRowView(entry: entry, state: state, model: model)
                        }
                    }
                    .transition(state.reduceMotion ? .opacity : .asymmetric(
                        insertion: .move(edge: .top).combined(with: .opacity), removal: .opacity))
                }
            }
            if hidden > 0 { foldRow }
        }
        .padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 14)
        .onHover { state.cueHovered = $0 }
        .animation(Theme.listChange, value: entries.map(\.key))
        .animation(Theme.listChange, value: state.featuredKey)
        .animation(Theme.interaction, value: state.cueHovered && entries.count == 1)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.tr("\(entries.count) 件提醒在等你"))
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(L10n.tr("\(entries.count) 件在等你"))
                .font(.system(size: 11, weight: .semibold)).foregroundStyle(.white.opacity(0.6))
            if state.deferredCount > 0 {
                Text(L10n.tr("+\(state.deferredCount) 条新提醒"))
                    .font(.system(size: 10.5, weight: .semibold)).foregroundStyle(Dial.orange)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Capsule().fill(Dial.orange.opacity(0.16)))
                    .transition(.opacity)
            }
            Spacer(minLength: 4)
            Button { state.onOpenQuickLook?() } label: {
                HStack(spacing: 3) {
                    Text(L10n.tr("今天")).font(.system(size: 11, weight: .medium))
                    Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold))
                }
                .foregroundStyle(.white.opacity(0.6))
                .padding(.horizontal, 8).padding(.vertical, 5)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityLabel(L10n.tr("打开今天的快览"))
            Button { state.onStackCollapse?() } label: { Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)) }
                .buttonStyle(QuietIconButtonStyle(width: 26)).foregroundStyle(.white.opacity(0.55))
                .help(L10n.tr("先收起，提醒仍留在刘海上"))
                .accessibilityLabel(L10n.tr("先收起提醒，仍留在刘海上"))
        }
        .padding(.horizontal, 4)
    }

    private var foldRow: some View {
        Button { state.onOpenQuickLook?() } label: {
            HStack(spacing: 6) {
                Text(L10n.tr("还有 \(hidden) 件 · 在快览里查看")).font(.system(size: 12.5, weight: .semibold))
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold))
            }
            .foregroundStyle(.white.opacity(0.75))
            .frame(maxWidth: .infinity).frame(height: 36)
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.white.opacity(0.22), style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L10n.tr("还有 \(hidden) 件提醒，在快览里查看"))
    }
}

/// One resting reminder: what it is, how long it has waited, and the two answers that matter.
struct CueRowView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    let entry: CueEntry
    @ObservedObject var state: NotchState
    @ObservedObject var model: AppModel
    @State private var hovered = false

    private var busy: Bool { state.busyKeys.contains(entry.key) }
    private var isPeriodic: Bool { entry.cue.periodic != nil }

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 10) {
                ZStack {
                    Circle().fill(isPeriodic ? Dial.orange : Color.white.opacity(0.14)).frame(width: 30, height: 30)
                    if isPeriodic { CueMark().environment(\.accent, .white).scaleEffect(0.78) }
                    else { Image(systemName: "clock").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white) }
                }
                .accessibilityHidden(true)
                Button { state.onCueOpen?(entry.key) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.cue.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                        TimelineView(.periodic(from: .now, by: 30)) { context in
                            Text(CueText.meta(for: entry, model: model, now: context.date))
                                .font(.system(size: 11)).foregroundStyle(.white.opacity(0.5)).lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel(L10n.tr("打开提醒任务 \(entry.cue.title)"))
                if entry.repeats > 1 { RepeatBadge(count: entry.repeats) }
                if isPeriodic {
                    Menu {
                        Button(L10n.tr("今天暂停")) { state.onCuePauseToday?(entry.key) }
                    } label: { Image(systemName: "ellipsis").foregroundStyle(.white.opacity(0.6)) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).frame(width: 20)
                    .accessibilityLabel(L10n.tr("更多提醒操作"))
                }
                if busy {
                    ProgressView().controlSize(.small).frame(width: 64)
                } else {
                    Button { state.onCueSnooze?(entry.key) } label: { Image(systemName: "zzz") }
                        .buttonStyle(QuietIconButtonStyle()).foregroundStyle(.white.opacity(0.8))
                        .help(L10n.tr("10 分钟后"))
                        .accessibilityLabel(L10n.tr("Cue 提醒延后 10 分钟"))
                    Button { state.onCueComplete?(entry.key) } label: {
                        Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                            .frame(width: 30, height: 30).background(Circle().fill(Dial.orange))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(isPeriodic ? L10n.tr("完成本次") : L10n.tr("完成提醒任务"))
                }
            }
            .disabled(!model.canWrite || busy)
            if let error = state.errors[entry.key] {
                Text(error).font(.system(size: 11)).foregroundStyle(.orange).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6)
            }
        }
        .padding(.horizontal, 9).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white.opacity(hovered ? 0.1 : 0.07)))
        .onHover { hovered = $0 }
        .animation(Theme.interaction, value: hovered)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.tr("TodoCue 提醒：\(entry.cue.title)"))
    }
}

/// "Waiting for you" at the top of the quick look: the same rows, in the same order, as the stack.
struct NotchPendingSection: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @ObservedObject var state: NotchState
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(L10n.tr("待你回应")).font(.system(size: 11, weight: .semibold)).foregroundStyle(Dial.orange)
                Text("\(state.entries.count)").font(Dial.numeral(10)).monospacedDigit().foregroundStyle(Dial.orange.opacity(0.8))
                Spacer()
            }
            .padding(.horizontal, 6)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            ForEach(state.entries) { entry in
                CueRowView(entry: entry, state: state, model: model)
            }
        }
        .animation(Theme.listChange, value: state.entries.map(\.key))
    }
}
