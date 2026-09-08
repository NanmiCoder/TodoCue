import AppKit
import SwiftUI
import TodoCueKit

/// Which surface a drag belongs to. The list views map onto `PanelTab`, whose `rawValue` is the
/// server's `ListView` and is sent as `MoveTaskInput.view`; the calendar is client-only and
/// reschedules by patching the task instead, so it must never borrow one of those names.
enum DragSurface: Hashable {
    case list(PanelTab)
    case calendar

    var tab: PanelTab? {
        if case .list(let tab) = self { return tab }
        return nil
    }
}

struct TaskDrag {
    let task: TodoTask
    let surface: DragSurface
    let group: String
    let revision: Int
}

struct TaskDropTarget: Equatable {
    let surface: DragSurface
    let group: String
    let beforeId: String?
}

/// A calendar drop that would plan work after its own deadline; the reader confirms or cancels.
struct PendingReschedule: Identifiable {
    let id = UUID()
    let task: TodoTask
    let date: String
}

/// Restores the plan a calendar drag moved away from. Holds the two wire fields rather than a
/// `TaskPayload`, which is not `Equatable` and so could not live on a `Toast`.
struct UndoReschedule: Equatable {
    let taskId: String
    let scheduledDate: String?
    let scheduledAt: String?

    init(task: TodoTask) {
        taskId = task.id
        scheduledDate = task.scheduledDate
        scheduledAt = task.scheduledAt
    }

    /// `set` writes an explicit null for nil, which is what clears the other half of the pair.
    var payload: TaskPayload {
        var payload = TaskPayload()
        payload.set("scheduledDate", scheduledDate)
        payload.set("scheduledAt", scheduledAt)
        return payload
    }
}

struct PendingTaskMove: Identifiable {
    let id = UUID()
    let drag: TaskDrag
    let target: TaskDropTarget

    var message: String {
        guard drag.group != target.group else { return L10n.tr("已调整执行顺序") }
        if target.surface == .list(.all) { return L10n.tr("已移至「\(target.group.isEmpty ? L10n.tr("未分组") : target.group)」") }
        return L10n.tr("已改期至 \(TCDate.dateLabel(target.group))，截止与提醒保持原值")
    }

    func payload(allowPastDeadline: Bool) -> TaskPayload {
        var p = TaskPayload()
        p.set("view", drag.surface.tab?.rawValue)
        p.set("sourceGroup", drag.group)
        p.set("targetGroup", target.group)
        p.set("beforeId", target.beforeId)
        p.set("expectedVersion", drag.task.version)
        p.set("expectedRevision", drag.revision)
        p.fields["allowPastDeadline"] = .bool(allowPastDeadline)
        return p
    }
}

/// Tracks an in-panel drag without exporting task contents to the pasteboard.
/// Native mouse-up is the only commit point; Escape and leaving the panel cancel.
struct TaskDragHandle: NSViewRepresentable {
    let task: TodoTask
    let enabled: Bool
    let model: AppModel
    let begin: () -> Bool

    func makeNSView(context: Context) -> HandleView { HandleView() }
    func updateNSView(_ view: HandleView, context: Context) {
        view.enabled = enabled
        view.model = model
        view.begin = begin
        view.toolTip = enabled ? L10n.tr("拖动调整执行顺序；跨分组可修改项目或计划日期") : L10n.tr("当前无法拖动")
        view.setAccessibilityLabel(L10n.tr("拖动 \(task.title)"))
        view.needsDisplay = true
        view.window?.invalidateCursorRects(for: view)
    }

    final class HandleView: NSView {
        var enabled = false
        weak var model: AppModel?
        var begin: (() -> Bool)?
        private var origin: NSPoint?
        private var trackingDrag = false
        private var scrollTimer: Timer?
        override var mouseDownCanMoveWindow: Bool { false }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

        override func draw(_ dirtyRect: NSRect) {
            (enabled ? NSColor.secondaryLabelColor : NSColor.tertiaryLabelColor).setFill()
            for x in [bounds.midX - 2.5, bounds.midX + 2.5] {
                for y in [bounds.midY - 5, bounds.midY, bounds.midY + 5] {
                    NSBezierPath(ovalIn: NSRect(x: x - 1, y: y - 1, width: 2, height: 2)).fill()
                }
            }
        }
        override func resetCursorRects() {
            if enabled { addCursorRect(bounds, cursor: .openHand) }
        }
        override func mouseDown(with event: NSEvent) {
            guard enabled else { return }
            window?.makeKey() // Escape must reach the panel during an explicit drag.
            origin = event.locationInWindow
        }
        override func mouseDragged(with event: NSEvent) {
            guard enabled, let origin else { return }
            if !trackingDrag {
                guard hypot(event.locationInWindow.x - origin.x, event.locationInWindow.y - origin.y) > 6,
                      begin?() == true else { return }
                trackingDrag = true
                NSCursor.closedHand.push()
                let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.scrollAtEdge() }
                scrollTimer = timer
                RunLoop.main.add(timer, forMode: .common)
            }
            updateTarget(at: event.locationInWindow)
        }
        override func mouseUp(with event: NSEvent) {
            guard trackingDrag else { origin = nil; return }
            updateTarget(at: event.locationInWindow)
            if let target = model?.dropTarget { _ = model?.dropTask(at: target) }
            finish()
        }
        private func finish() {
            scrollTimer?.invalidate(); scrollTimer = nil
            if trackingDrag { NSCursor.pop() }
            trackingDrag = false; origin = nil
            model?.endTaskDrag()
        }
        private func updateTarget(at point: NSPoint) {
            guard let model, let origin, let window else { return }
            model.updateTaskDrag(at: point, origin: origin, in: window)
        }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window == nil && trackingDrag { finish() }
        }
        private func scrollAtEdge() {
            guard model?.draggedTask != nil, let window else { finish(); return }
            scrollAtEdge(at: window.convertPoint(fromScreen: NSEvent.mouseLocation))
        }
        func scrollAtEdge(at windowPoint: NSPoint) {
            // Resolve the enclosing scroll view every tick as the panel may resize.
            guard let scroll = enclosingScrollView, let document = scroll.documentView else { return }
            let clip = scroll.contentView
            let point = clip.convert(windowPoint, from: nil)
            let bounds = clip.bounds
            guard point.x >= bounds.minX, point.x <= bounds.maxX, point.y >= bounds.minY - 20, point.y <= bounds.maxY + 20 else {
                updateTarget(at: windowPoint); return
            }
            let step: CGFloat = point.y < bounds.minY + 32 ? -10 : point.y > bounds.maxY - 32 ? 10 : 0
            if step != 0 {
                let maxY = max(0, document.bounds.height - bounds.height)
                clip.scroll(to: NSPoint(x: bounds.origin.x, y: min(maxY, max(0, bounds.origin.y + step))))
                scroll.reflectScrolledClipView(clip)
            }
            updateTarget(at: windowPoint)
        }
        deinit { scrollTimer?.invalidate() }
    }
}

/// Background regions never intercept row buttons. Hit testing intersects bounds and visibleRect,
/// so clipped rows and areas outside the scroll view cannot receive a drop.
struct TaskDropRegion: NSViewRepresentable {
    let surface: DragSurface
    let group: String
    let beforeId: String?
    var afterId: String? = nil
    var isRow = false
    var isHeader = false
    var enabled = true
    /// A region that measures but never accepts a drop. Calendar rows need a frame so the lifted
    /// row can be positioned, while the only landing places are the day cells.
    var droppable = true

    func makeNSView(context: Context) -> RegionView { RegionView() }
    func updateNSView(_ region: RegionView, context: Context) {
        region.target = TaskDropTarget(surface: surface, group: group, beforeId: beforeId)
        region.afterId = afterId
        region.isRow = isRow
        region.isHeader = isHeader
        region.enabled = enabled
        region.droppable = droppable
    }
    final class RegionView: NSView {
        private static let regions = NSHashTable<RegionView>.weakObjects()
        var target: TaskDropTarget?
        var afterId: String?
        var isRow = false
        var isHeader = false
        var enabled = true
        var droppable = true
        override var isFlipped: Bool { true }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window != nil { Self.regions.add(self) } else { Self.regions.remove(self) }
        }
        var slot: TaskDragSlot? {
            guard let target else { return nil }
            return TaskDragSlot(surface: target.surface, group: target.group,
                                kind: isRow ? .row : isHeader ? .header : .end,
                                taskID: isRow ? target.beforeId : nil)
        }
        static func frames(in window: NSWindow, surface: DragSurface) -> [TaskDragFrame] {
            regions.allObjects.compactMap { region in
                guard region.enabled, region.window === window, !region.isHiddenOrHasHiddenAncestor,
                      let slot = region.slot, slot.surface == surface else { return nil }
                let rect = region.convert(region.bounds, to: nil)
                return TaskDragFrame(slot: slot, rect: CGRect(x: rect.minX, y: -rect.maxY, width: rect.width, height: rect.height))
            }
        }
        static func target(at point: NSPoint, in window: NSWindow, surface: DragSurface) -> TaskDropTarget? {
            var nearest: (distance: CGFloat, target: TaskDropTarget)?
            for region in regions.allObjects where region.enabled && region.droppable && region.window === window && !region.isHiddenOrHasHiddenAncestor {
                guard let target = region.target, target.surface == surface else { continue }
                let local = region.convert(point, from: nil)
                let visible = region.bounds.intersection(region.visibleRect)
                guard !visible.isEmpty, local.x >= visible.minX, local.x <= visible.maxX else { continue }
                if let clip = region.enclosingScrollView?.contentView,
                   !clip.bounds.contains(clip.convert(point, from: nil)) { continue }
                let candidate = region.isRow && local.y > region.bounds.midY
                    ? TaskDropTarget(surface: surface, group: target.group, beforeId: region.afterId) : target
                if visible.contains(local) { return candidate }
                // Bridge small stack gutters. Clearing the projection for the 2pt
                // gap between rows would make neighbours snap back on every crossing.
                let distance = max(visible.minY - local.y, local.y - visible.maxY, 0)
                if distance <= 6 && (nearest == nil || distance < nearest!.distance) { nearest = (distance, candidate) }
            }
            return nearest?.target
        }
    }
}

struct DraggableTaskRow: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    let task: TodoTask
    let surface: DragSurface
    let group: String
    let nextId: String?
    var enabled = true
    var reasons: [TodayReason] = []
    var showProject = true
    var compact = false
    /// The calendar drags to change a date, not to reorder, so its rows are not landing places.
    var reorderable = true

    private var canDrag: Bool { enabled && model.canWrite && !model.isMovingTask && task.status == .todo && !model.completingTaskIDs.contains(task.id) }
    private var slot: TaskDragSlot { TaskDragSlot(surface: surface, group: group, kind: .row, taskID: task.id) }
    private var lifted: TaskDragPresentation? {
        guard let presentation = model.dragPresentation, presentation.source == slot else { return nil }
        return presentation
    }
    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            TaskDragHandle(task: task, enabled: canDrag, model: model,
                           begin: { model.beginTaskDrag(task, surface: surface, group: group) })
                .frame(width: 16, height: 30).padding(.top, compact ? 4 : 7)
                .opacity(canDrag ? 0.65 : 0.2)
            TaskRowView(task: task, reasons: reasons, showProject: showProject, compact: compact)
        }
        .opacity(lifted == nil ? 1 : 0)
        .offset(y: model.dragOffset(slot))
        .animation(Theme.dragShift, value: model.dragOffset(slot))
        .overlay {
            if let lifted {
                RoundedRectangle(cornerRadius: 10)
                    .fill(Color.accentColor.opacity(0.045))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentColor.opacity(0.16), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                    .offset(lifted.projection.landingOffset)
                    .animation(Theme.dragShift, value: lifted.projection.landingOffset)
                    .allowsHitTesting(false)
                HStack(alignment: .top, spacing: 0) {
                    Image(systemName: "line.3.horizontal").font(.system(size: 9)).foregroundStyle(.tertiary)
                        .frame(width: 16, height: 30).padding(.top, compact ? 4 : 7)
                    TaskRowView(task: task, reasons: reasons, showProject: showProject, compact: compact)
                }
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5))
                .shadow(color: .black.opacity(lifted.phase == .dragging ? 0.17 : 0.06), radius: lifted.phase == .dragging ? 12 : 3, y: lifted.phase == .dragging ? 5 : 1)
                .scaleEffect(lifted.phase == .dragging && !Theme.reduceMotion ? 1.02 : 1)
                .offset(lifted.translation)
                // Direct manipulation has no easing; only release/return is animated.
                .animation(lifted.phase == .dragging ? nil : Theme.dragSettle, value: lifted.translation)
                .animation(Theme.dragSettle, value: lifted.phase)
                .allowsHitTesting(false).accessibilityHidden(true)
            }
        }
        .zIndex(lifted == nil ? 0 : 10)
        // The measurement/hit region stays at its original layout position.
        .background(TaskDropRegion(surface: surface, group: group, beforeId: task.id, afterId: nextId,
                                   isRow: true, enabled: enabled, droppable: reorderable))
    }
}

struct DraggableSectionHeader: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    let title: String
    let count: Int
    let view: PanelTab
    let group: String
    let firstId: String?
    var enabled = true
    var color: Color = .secondary

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 0) {
                SectionHeader(title: title, count: count, color: color)
                if model.hasManualOrder(view: view, group: group) {
                    Menu {
                        Button(L10n.tr("恢复自动排序")) { model.resetOrder(view: view, group: group) }
                    } label: { Image(systemName: "arrow.up.arrow.down").font(.system(size: 10)) }
                    .menuStyle(.borderlessButton).fixedSize()
                    .disabled(!enabled || !model.canWrite || model.isMovingTask || model.draggedTask != nil)
                    .help(L10n.tr("手动排序 · 恢复自动排序"))
                    .accessibilityLabel(L10n.tr("\(title)的排序选项"))
                }
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .offset(y: model.dragOffset(TaskDragSlot(surface: .list(view), group: group, kind: .header)))
        .animation(Theme.dragShift, value: model.dragOffset(TaskDragSlot(surface: .list(view), group: group, kind: .header)))
        .background(TaskDropRegion(surface: .list(view), group: group, beforeId: firstId, isHeader: true, enabled: enabled))
    }
}

struct TaskGroupEnd: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    let view: PanelTab
    let group: String
    var enabled = true
    var body: some View {
        Color.clear.frame(height: 10).contentShape(Rectangle())
            .offset(y: model.dragOffset(TaskDragSlot(surface: .list(view), group: group, kind: .end)))
            .animation(Theme.dragShift, value: model.dragOffset(TaskDragSlot(surface: .list(view), group: group, kind: .end)))
            .background(TaskDropRegion(surface: .list(view), group: group, beforeId: nil, enabled: enabled))
    }
}
