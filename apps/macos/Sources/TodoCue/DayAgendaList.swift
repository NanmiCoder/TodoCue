import SwiftUI
import TodoCueKit

/// One day's work, shared by the month view's agenda pane and by each block of the week view.
/// Rows are plain `TaskRowView`s: reordering has no meaning inside a date, and `DraggableTaskRow`
/// would register frames into the Upcoming drag graph, whose region table is keyed only by window
/// and `PanelTab`.
struct DayAgendaList: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    let date: String
    /// Week blocks hide themselves when there is nothing to say; the month agenda shows a placeholder.
    var hidesWhenEmpty = false
    /// nil until the reader decides: on a past day the completed work is the whole day, so it opens.
    @State private var completedExpanded: Bool?

    private var bucket: CalendarDayBucket { model.calendarBucket(date) }
    private var onlyHistory: Bool {
        bucket.planned.isEmpty && bucket.deadlines.isEmpty && bucket.ghosts.isEmpty
    }

    var body: some View {
        if bucket.isEmpty && hidesWhenEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 4) {
                DayAgendaHeader(date: date, bucket: bucket)
                if bucket.isEmpty {
                    // Not `EmptyStateView`: its concentric rings are ~180pt tall and this pane can
                    // be as short as 120pt, so the placeholder would have to be scrolled.
                    Text(model.calendarHistoryUnavailable ? L10n.tr("离线，只显示待办") : L10n.tr("这一天没有安排"))
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4).padding(.vertical, 10)
                } else {
                    ForEach(bucket.planned) { task in TaskRowView(task: task, compact: true) }
                    if !bucket.deadlines.isEmpty {
                        // Red only when something here is actually late; a deadline that is merely
                        // approaching should not read as an alarm.
                        SectionHeader(title: L10n.tr("截止"), count: bucket.deadlines.count,
                                      color: bucket.deadlines.contains(where: \.isOverdue) ? Theme.overdue : .secondary)
                        // These are planned on another day; their metadata line carries that date.
                        ForEach(bucket.deadlines) { task in TaskRowView(task: task, compact: true) }
                    }
                    if !bucket.ghosts.isEmpty {
                        SectionHeader(title: L10n.tr("待生成"), count: bucket.ghosts.count)
                        ForEach(bucket.ghosts) { ghost in GhostRowView(ghost: ghost) }
                    }
                    if !bucket.history.isEmpty {
                        CompletedDayView(tasks: bucket.history, showsDivider: !onlyHistory,
                                         expanded: Binding(get: { completedExpanded ?? onlyHistory },
                                                           set: { completedExpanded = $0 }))
                    }
                }
            }
        }
    }
}

private struct DayAgendaHeader: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @Environment(\.accent) private var accent
    let date: String
    let bucket: CalendarDayBucket

    var body: some View {
        HStack(spacing: 6) {
            Text(CalendarRange.dayLabel(date, language: languagePreferences.language))
                .font(.system(size: 13, weight: .semibold)).tracking(-0.2)
                .foregroundStyle(date == TCDate.todayString() ? accent : Color.primary)
            Spacer(minLength: 4)
            if bucket.openCount > 0 {
                Text(L10n.tr("\(bucket.openCount) 件")).font(.system(size: 11)).monospacedDigit()
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 4)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A recurring occurrence the runtime has not created yet: no id, no version, so nothing to act on.
struct GhostRowView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    let ghost: SeriesProjection.Ghost

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "repeat").font(.system(size: 11))
                .foregroundStyle(.tertiary).frame(width: 30, height: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(ghost.title)
                    .font(.system(size: 14, weight: .medium)).tracking(-0.15)
                    .foregroundStyle(.secondary).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                // No "not created yet" chip here: the section header above already says so.
                FlowLayout(spacing: 8, rowSpacing: 3) {
                    if let time = ghost.scheduledTime { Text(time) }
                    if let project = ghost.project, !project.isEmpty { Text(project) }
                }
                .font(.system(size: 10)).foregroundStyle(.tertiary)
            }
            .padding(.top, 2)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4).padding(.horizontal, 3)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L10n.tr("\(ghost.title)，重复任务，运行时尚未生成"))
    }
}

/// Mirrors `CompletedTodayView`, but for an arbitrary date.
private struct CompletedDayView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    let tasks: [TodoTask]
    var showsDivider = true
    @Binding var expanded: Bool

    var body: some View {
        VStack(spacing: 5) {
            if showsDivider { Divider().opacity(0.4).padding(.vertical, 4) }
            Button { withAnimation(Theme.listChange) { expanded.toggle() } } label: {
                HStack(spacing: 7) {
                    Image(systemName: "chevron.right").rotationEffect(.degrees(expanded ? 90 : 0))
                        .font(.system(size: 9, weight: .semibold))
                    Text(L10n.tr("已完成")).font(.system(size: 12, weight: .medium))
                    Text("\(tasks.count)").font(.system(size: 12)).monospacedDigit()
                    Spacer()
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4).padding(.vertical, 5)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(expanded ? L10n.tr("收起已完成") : L10n.tr("展开已完成"))
            if expanded {
                ForEach(tasks) { task in TaskRowView(task: task, compact: true) }
            }
        }
    }
}
