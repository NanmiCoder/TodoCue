import Foundation

/// Stable layout slots, analogous to dnd-kit's measured sortable rectangles.
/// Visual transforms never change these hit-test rectangles.
struct TaskDragSlot: Hashable {
    enum Kind: Hashable { case row, header, end }
    let surface: DragSurface
    let group: String
    let kind: Kind
    var taskID: String? = nil
}

struct TaskDragFrame: Equatable {
    let slot: TaskDragSlot
    /// Window coordinates with y increasing downward, including offscreen rows.
    let rect: CGRect
}

struct TaskDragProjection: Equatable {
    var offsets: [TaskDragSlot: CGFloat] = [:]
    var landingOffset: CGSize = .zero

    static func evaluate(frames: [TaskDragFrame], source: TaskDragSlot, target: TaskDropTarget?) -> Self {
        let ordered = frames.filter { $0.slot.surface == source.surface }.sorted { $0.rect.minY < $1.rect.minY }
        guard let from = ordered.firstIndex(where: { $0.slot == source }), let target,
              target.surface == source.surface,
              source.surface != .list(.today) || target.group == source.group,
              let to = ordered.firstIndex(where: {
                  $0.slot.group == target.group && (target.beforeId == nil
                      ? $0.slot.kind == .end : $0.slot.kind == .row && $0.slot.taskID == target.beforeId)
              }), from != to else { return Self() }
        let sourceRect = ordered[from].rect
        // Each section's stack has 2pt between rows, including the terminal slot.
        let stride = sourceRect.height + 2
        var projection = Self()
        if to > from {
            for index in (from + 1)..<to { projection.offsets[ordered[index].slot] = -stride }
            projection.landingOffset = CGSize(width: ordered[to].rect.minX - sourceRect.minX,
                                              height: ordered[to].rect.minY - stride - sourceRect.minY)
        } else {
            for index in to..<from { projection.offsets[ordered[index].slot] = stride }
            projection.landingOffset = CGSize(width: ordered[to].rect.minX - sourceRect.minX,
                                              height: ordered[to].rect.minY - sourceRect.minY)
        }
        return projection
    }
}

struct TaskDragPresentation: Equatable {
    enum Phase: Equatable { case dragging, landing, returning }
    let id: UUID
    let source: TaskDragSlot
    let grabOffset: CGPoint
    var translation: CGSize
    var projection: TaskDragProjection
    var phase: Phase = .dragging
    var settleUntil: Date? = nil
}
