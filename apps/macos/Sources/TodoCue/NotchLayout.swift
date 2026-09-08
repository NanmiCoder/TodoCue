import Foundation
import TodoCueKit

/// Geometry and content selection for the notch quick-look, kept free of AppKit so it can be tested.
enum NotchLayout {
    struct SectionGroup: Equatable {
        let section: TodaySection
        var items: [TodayItem]
    }

    struct Selection: Equatable {
        let rows: [TodayItem]
        let hidden: Int
        let groups: [SectionGroup]
    }

    struct Countdown: Equatable {
        let text: String
        let late: Bool
    }

    /// Collapsed bar: the physical notch, a hover slack on both sides and, when shown, a summary wing on each side.
    static func collapsedFrame(notch: CGRect, slack: CGFloat, wing: CGFloat) -> CGRect {
        let extra = max(0, slack) + max(0, wing)
        return CGRect(x: notch.minX - extra, y: notch.minY, width: notch.width + 2 * extra, height: notch.height)
    }

    /// Expanded card: hangs from the top edge, centered on the notch, clamped into the screen.
    static func expandedFrame(notch: CGRect, screen: CGRect, contentHeight: CGFloat, width: CGFloat, maxHeight: CGFloat) -> CGRect {
        let w = min(width, screen.width)
        let h = min(maxHeight, screen.height, max(0, contentHeight) + notch.height)
        let x = min(max(screen.minX, notch.midX - w / 2), screen.maxX - w)
        return CGRect(x: x, y: screen.maxY - h, width: w, height: h)
    }

    /// Fullscreen windows may start below the camera/menu-bar safe area. Coordinates are AppKit's.
    static func coversScreen(_ window: CGRect, screen: CGRect, topInset: CGFloat) -> Bool {
        let tolerance: CGFloat = 2
        let topGap = screen.maxY - window.maxY
        return abs(window.minX - screen.minX) <= tolerance
            && abs(window.width - screen.width) <= tolerance
            && abs(window.minY - screen.minY) <= tolerance
            && topGap >= -tolerance && topGap <= max(0, topInset) + tolerance
    }

    /// Rows under the next card: open tasks in section order, without the next task, capped to `limit`.
    static func select(items: [TodayItem], nextId: String?, limit: Int) -> Selection {
        let order: [TodaySection] = [.overdue, .must, .scheduled]
        let open = items
            .filter { $0.task.status == .todo && $0.task.id != nextId }
            .enumerated()
            .sorted { a, b in
                let ra = order.firstIndex(of: a.element.section) ?? order.count
                let rb = order.firstIndex(of: b.element.section) ?? order.count
                return ra == rb ? a.offset < b.offset : ra < rb
            }
            .map(\.element)
        let rows = Array(open.prefix(max(0, limit)))
        var groups: [SectionGroup] = []
        for item in rows {
            if let i = groups.firstIndex(where: { $0.section == item.section }) {
                groups[i].items.append(item)
            } else {
                groups.append(SectionGroup(section: item.section, items: [item]))
            }
        }
        return Selection(rows: rows, hidden: open.count - rows.count, groups: groups)
    }

    /// Relative label for the next task's planned time or deadline; nil when the task has no time.
    static func countdown(for task: TodoTask, now: Date = Date()) -> Countdown? {
        let isDeadline = task.scheduledAt == nil
        guard let iso = task.scheduledAt ?? task.dueAt, let at = TCDate.parse(iso) else { return nil }
        let delta = at.timeIntervalSince(now)
        let late = delta < 0
        let minutes = Int((abs(delta) / 60).rounded(.down))
        let span: String
        if minutes < 1 {
            span = ""
        } else if minutes < 60 {
            span = L10n.tr("\(minutes) 分钟")
        } else if minutes < 24 * 60 {
            let h = minutes / 60, m = minutes % 60
            span = m == 0 ? L10n.tr("\(h) 小时") : L10n.tr("\(h) 小时 \(m) 分")
        } else {
            span = L10n.tr("\(minutes / (24 * 60)) 天")
        }
        let text: String
        switch (isDeadline, late, span.isEmpty) {
        case (false, false, true): text = L10n.tr("就是现在")
        case (false, false, false): text = L10n.tr("还有 ") + span
        case (false, true, true): text = L10n.tr("刚到时间")
        case (false, true, false): text = L10n.tr("已过 ") + span
        case (true, false, true): text = L10n.tr("马上截止")
        case (true, false, false): text = L10n.tr("距截止 ") + span
        case (true, true, true): text = L10n.tr("刚刚截止")
        case (true, true, false): text = L10n.tr("已逾期 ") + span
        }
        return Countdown(text: text, late: late)
    }
}
