import SwiftUI
import TodoCueKit

/// Month = find, week = plan.
///
/// A month cell is about 35pt wide at the 300pt panel minimum, so it carries a day number and
/// status marks only; the agenda underneath is where a day becomes readable and actionable — that
/// pane is also what a "day view" would have been. The week span drops the grid entirely and stacks
/// seven day blocks, which is the form that survives a short panel.
struct CalendarView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel

    var body: some View {
        GeometryReader { geometry in
            // Match the list's gutter ramp: 12pt at 300pt, 16pt at 340pt and above.
            let inset = min(16, 12 + max(0, geometry.size.width - Theme.panelMinWidth) * 0.1)
            // The quick-add row is pinned under the calendar, so it is not the grid's to spend.
            let available = geometry.size.height - CalendarLayout.quickAdd
            VStack(spacing: 0) {
                CalendarNavigator(available: available)
                    .frame(height: CalendarLayout.navigator)
                    .padding(.horizontal, inset)
                switch model.calendarSpan {
                case .month: monthBody(available: available, inset: inset)
                case .week: weekBody(inset: inset)
                }
                QuickAddView(date: model.calendarSelected).padding(.horizontal, inset)
            }
            .overlay(alignment: .bottom) {
                if let hint = model.dragHint, model.draggedTask?.surface == .calendar {
                    Text(hint).font(.system(size: 11)).padding(8)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 8))
                        .padding(.bottom, CalendarLayout.quickAdd + 6)
                        .allowsHitTesting(false)
                }
            }
        }
        .animation(Theme.interaction, value: model.calendarSpan)
        .alert(L10n.tr("计划晚于截止时间"), isPresented: Binding(get: { model.pendingReschedule != nil },
                                                    set: { if !$0 { model.pendingReschedule = nil } }),
               presenting: model.pendingReschedule) { pending in
            Button(L10n.tr("保留截止日期并改期")) { model.reschedule(pending.task, to: pending.date, confirmedPastDeadline: true) }
                .disabled(!model.canWrite || model.isMovingTask)
            Button(L10n.tr("取消"), role: .cancel) { model.pendingReschedule = nil }
        } message: { pending in
            Text(L10n.tr("将「\(pending.task.title)」改期到 \(TCDate.dateLabel(pending.date))，会晚于原截止时间。截止日期和提醒时间将保持原值。"))
        }
    }

    @ViewBuilder private func monthBody(available: CGFloat, inset: CGFloat) -> some View {
        let rows = CalendarRange.weekRows(span: .month, anchor: model.calendarAnchor,
                                          firstWeekday: model.calendarFirstWeekday)
        let metrics = CalendarLayout.metrics(available: available, weekRows: rows,
                                             forceExpanded: model.calendarGridExpanded)
        // Collapsed, the grid shows just the week holding the selection rather than a clipped month.
        let days = metrics.collapsed
            ? CalendarRange.days(span: .week, anchor: model.calendarSelected, firstWeekday: model.calendarFirstWeekday)
            : CalendarRange.days(span: .month, anchor: model.calendarAnchor, firstWeekday: model.calendarFirstWeekday)

        VStack(spacing: 0) {
            WeekdayHeader().frame(height: CalendarLayout.weekdayHeader).padding(.horizontal, inset)
            MonthGridView(days: days, cellHeight: metrics.cellHeight)
                .frame(height: metrics.gridHeight)
                .padding(.horizontal, inset)
            ScrollView {
                DayAgendaList(date: model.calendarSelected)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            // A new day starts at the top of its own list, and a toast must squeeze this pane
            // rather than the grid, so the height stays flexible instead of pinned.
            .id(model.calendarSelected)
            .frame(maxHeight: .infinity)
            .scrollIndicators(.automatic)
            // Same rows as the week span, so the same substrate as the week span.
            .cueSurface(radius: 18)
            .padding(.horizontal, inset)
            .padding(.top, 8)
        }
    }

    @ViewBuilder private func weekBody(inset: CGFloat) -> some View {
        let days = CalendarRange.days(span: .week, anchor: model.calendarAnchor,
                                      firstWeekday: model.calendarFirstWeekday)
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                // All seven days, always: a week planner that hides its empty days is the one you
                // cannot drag onto, and those are exactly the days with room.
                if days.allSatisfy({ model.calendarBucket($0).isEmpty }) {
                    Text(L10n.tr("这一周没有安排"))
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                        .padding(.horizontal, 4).padding(.bottom, 2)
                }
                ForEach(days, id: \.self) { day in
                    DayAgendaList(date: day, isWeekBlock: true)
                        .onTapGesture { model.setCalendar(selected: day) }
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .id(model.calendarAnchor)
        .frame(maxHeight: .infinity)
        .scrollIndicators(.automatic)
        .cueSurface(radius: 18)
        .padding(.horizontal, inset)
    }
}

/// Span switcher, grid disclosure and the month/week stepper, all on one 38pt line — the widest
/// case is English "September 2026", which is why the title template is `yMMM` and not `yMMMM`.
private struct CalendarNavigator: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    @State private var titleHovered = false
    let available: CGFloat

    private var canExpand: Bool {
        model.calendarSpan == .month
            && CalendarLayout.canExpand(available: available,
                                        weekRows: CalendarRange.weekRows(span: .month, anchor: model.calendarAnchor,
                                                                         firstWeekday: model.calendarFirstWeekday))
    }

    private var expanded: Bool {
        CalendarLayout.metrics(available: available,
                               weekRows: CalendarRange.weekRows(span: .month, anchor: model.calendarAnchor,
                                                                firstWeekday: model.calendarFirstWeekday),
                               forceExpanded: model.calendarGridExpanded).collapsed == false
    }

    var body: some View {
        // Every element here competes for 256pt at the 300pt panel minimum, so the buttons are
        // narrowed and the title is the only part allowed to scale.
        // Every element here competes for 256pt at the 300pt panel minimum, so the buttons are
        // narrowed and the title is the only part allowed to scale.
        HStack(spacing: 3) {
            SegmentedCapsule(items: CalendarSpan.allCases, selected: model.calendarSpan, title: \.label,
                             select: { model.setCalendar(span: $0) },
                             fills: false, height: 24, fontSize: 11, trackPadding: 2,
                             label: L10n.tr("日历视图切换"))
                // Without this SwiftUI compresses the segment labels before the title, and English
                // "Month"/"Week" truncate to "Mo…"/"W…" at the 300pt panel minimum.
                .fixedSize()

            Spacer(minLength: 2)

            if canExpand {
                Button { withAnimation(Theme.interaction) { model.calendarGridExpanded = !expanded } } label: {
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                }
                .buttonStyle(QuietIconButtonStyle(width: 22)).foregroundStyle(.secondary)
                .help(expanded ? L10n.tr("收起月历") : L10n.tr("展开月历"))
                .accessibilityLabel(expanded ? L10n.tr("收起月历") : L10n.tr("展开月历"))
            }

            Button { model.stepCalendar(-1) } label: { Image(systemName: "chevron.left") }
                .buttonStyle(QuietIconButtonStyle(width: 22)).foregroundStyle(.secondary)
                .help(model.calendarSpan == .month ? L10n.tr("上个月") : L10n.tr("上一周"))
                .accessibilityLabel(model.calendarSpan == .month ? L10n.tr("上个月") : L10n.tr("上一周"))

            Button(action: model.calendarGoToToday) {
                HStack(spacing: 4) {
                    Text(CalendarRange.title(span: model.calendarSpan, anchor: model.calendarAnchor,
                                             firstWeekday: model.calendarFirstWeekday,
                                             language: languagePreferences.language))
                        .font(.system(size: 13, weight: .semibold)).tracking(-0.2)
                        .lineLimit(1).minimumScaleFactor(0.7)
                    // A quiet hint that the title is the way back, shown only when it would move.
                    if !model.calendarShowsToday {
                        Circle().fill(accent).frame(width: 4, height: 4)
                    }
                }
                .foregroundStyle(Color.primary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(Color.primary.opacity(titleHovered && !model.calendarShowsToday ? 0.06 : 0),
                        in: Capsule())
            .onHover { titleHovered = $0 }
            .animation(Theme.interaction, value: titleHovered)
            .help(L10n.tr("回到今天"))
            .accessibilityLabel(L10n.tr("回到今天"))

            Button { model.stepCalendar(1) } label: { Image(systemName: "chevron.right") }
                .buttonStyle(QuietIconButtonStyle(width: 22)).foregroundStyle(.secondary)
                .help(model.calendarSpan == .month ? L10n.tr("下个月") : L10n.tr("下一周"))
                .accessibilityLabel(model.calendarSpan == .month ? L10n.tr("下个月") : L10n.tr("下一周"))
        }
    }
}

/// Column headers, rotated to the first weekday the language implies.
private struct WeekdayHeader: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(CalendarRange.weekdaySymbols(firstWeekday: model.calendarFirstWeekday,
                                                       language: languagePreferences.language).enumerated()),
                    id: \.offset) { _, symbol in
                Text(symbol)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
            }
        }
        .accessibilityHidden(true)
    }
}

/// The seven-column grid. Sizing comes entirely from the window: nothing here may declare an
/// intrinsic width, because the panel's hosting view propagates none back.
private struct MonthGridView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    let days: [String]
    let cellHeight: CGFloat

    var body: some View {
        // Flexible columns with no minimum: the window proposes the width and content must never
        // push an intrinsic minimum back (`hosting.sizingOptions = []`).
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(minimum: 0), spacing: 2), count: 7), spacing: 0) {
            ForEach(days, id: \.self) { day in
                CalendarDayCell(date: day,
                                bucket: model.calendarBucket(day),
                                inSpan: CalendarRange.contains(span: model.calendarSpan, anchor: model.calendarAnchor,
                                                               date: day, firstWeekday: model.calendarFirstWeekday),
                                isToday: day == TCDate.todayString(),
                                isSelected: day == model.calendarSelected,
                                height: cellHeight)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(CalendarRange.title(span: model.calendarSpan, anchor: model.calendarAnchor,
                                                firstWeekday: model.calendarFirstWeekday,
                                                language: languagePreferences.language))
    }
}

/// A day number plus up to three marks. Overdue is carried by the *number*, not by a dot colour:
/// at 5pt the light-mode accent (dark green) and overdue (dark red) are indistinguishable, so the
/// marks differentiate by shape — filled dot, hollow ring, bar — and colour only reinforces.
private struct CalendarDayCell: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @Environment(\.accent) private var accent
    @Environment(\.colorScheme) private var scheme
    let date: String
    let bucket: CalendarDayBucket
    let inSpan: Bool
    let isToday: Bool
    let isSelected: Bool
    let height: CGFloat

    private enum Mark: Hashable { case deadline, todo, done, ghost }

    private var marks: [Mark] {
        Array(repeating: .deadline, count: bucket.deadlines.count)
            + Array(repeating: .todo, count: bucket.planned.count)
            + Array(repeating: .done, count: bucket.history.count)
            + Array(repeating: .ghost, count: bucket.ghosts.count)
    }

    private var numberColor: Color {
        if isSelected { return scheme == .dark ? Color.black.opacity(0.88) : .white }
        if bucket.hasOverdue { return Theme.overdue }
        if isToday { return accent }
        return inSpan ? .primary : Color.primary.opacity(0.3)
    }

    var body: some View {
        let shown = Array(marks.prefix(3))
        let overflow = marks.count > 3
        Button { model.setCalendar(selected: date) } label: {
            VStack(spacing: 2) {
                Text(CivilDate.parse(date).map { String($0.day) } ?? date)
                    .font(.system(size: 11, weight: isToday || isSelected ? .semibold : .regular))
                    .monospacedDigit()
                    .foregroundStyle(numberColor)
                    .frame(width: 20, height: 18)
                    .background {
                        if isSelected { Circle().fill(accent).frame(width: 20, height: 20) }
                    }
                HStack(spacing: 2) {
                    ForEach(Array(shown.enumerated()), id: \.offset) { index, mark in
                        let last = index == shown.count - 1
                        markView(mark, enlarged: overflow && last)
                    }
                }
                .frame(height: 6)
                .opacity(inSpan ? 1 : 0.4)
            }
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(CalendarDropTarget(date: date, cornerRadius: 8))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }

    @ViewBuilder private func markView(_ mark: Mark, enlarged: Bool) -> some View {
        let size: CGFloat = enlarged ? 6 : 5
        switch mark {
        case .deadline:
            Capsule().fill(Theme.overdue.opacity(0.75)).frame(width: 2, height: 6)
        case .todo:
            Circle().fill(accent).frame(width: size, height: size)
        // A 1pt ring at 5pt reads as noise in both themes; 1.4pt is the point where it holds.
        case .done:
            Circle().strokeBorder(Color.secondary.opacity(0.9), lineWidth: 1.4).frame(width: size, height: size)
        case .ghost:
            Circle().strokeBorder(accent.opacity(0.8), lineWidth: 1.4).frame(width: size, height: size)
        }
    }

    /// Overdue and deadlines are drawn as a red number and a red bar; both must also be spoken,
    /// or the state is conveyed by colour alone.
    private var accessibilityLabel: String {
        var label = CalendarRange.dayLabel(date, language: languagePreferences.language)
        if bucket.isEmpty { return L10n.tr("\(label)，没有安排") }
        if bucket.openCount > 0 { label = L10n.tr("\(label)，\(bucket.openCount) 件待办") }
        if bucket.hasOverdue { label = L10n.tr("\(label)，有逾期") }
        if !bucket.deadlines.isEmpty { label = L10n.tr("\(label)，\(bucket.deadlines.count) 件截止") }
        if !bucket.history.isEmpty { label = L10n.tr("\(label)，已完成 \(bucket.history.count) 件") }
        if !bucket.ghosts.isEmpty { label = L10n.tr("\(label)，\(bucket.ghosts.count) 件待生成") }
        return label
    }
}
