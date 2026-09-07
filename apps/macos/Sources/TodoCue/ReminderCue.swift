import Foundation
import TodoCueKit

struct ReminderCue: Identifiable, Equatable {
    let id: String
    let task: TodoTask
    let count: Int
    let late: Bool
    let receivedAt: Date

    static func from(_ event: RuntimeEvent, task: TodoTask, now: Date = Date()) -> ReminderCue? {
        guard event.type == .reminderFired, let id = event.id, event.related?["taskId"] == task.id,
              task.status == .todo, let at = TCDate.parse(event.at),
              now.timeIntervalSince(at) >= -5, now.timeIntervalSince(at) < 120,
              event.related?["fireAt"] == task.reminderAt else { return nil }
        return ReminderCue(id: id, task: task, count: max(1, Int(event.related?["count"] ?? "1") ?? 1),
                           late: event.related?["late"] == "true", receivedAt: at)
    }
}

/// Bounded FIFO plus replay protection. Dismissing a card never changes its task or reminder.
struct ReminderCueQueue {
    private(set) var pending: [ReminderCue] = []
    private var seen: [String: Date] = [:]
    mutating func append(_ cue: ReminderCue, now: Date = Date()) {
        seen = seen.filter { now.timeIntervalSince($0.value) < 300 }
        guard seen[cue.id] == nil, now.timeIntervalSince(cue.receivedAt) < 120 else { return }
        seen[cue.id] = now
        pending.append(cue)
        if pending.count > 20 { pending.removeFirst(pending.count - 20) }
    }
    mutating func next(now: Date = Date()) -> ReminderCue? {
        pending.removeAll { now.timeIntervalSince($0.receivedAt) >= 120 }
        return pending.isEmpty ? nil : pending.removeFirst()
    }
    mutating func clear() { pending.removeAll() }
}

enum CueMotion {
    struct Pose: Equatable { var scaleX: Double; var scaleY: Double; var offsetY: Double; var rotation: Double }
    /// Preparation, little hop, soft landing, settle; deterministic and confined to the Cue mark.
    static func pose(at time: TimeInterval, reduceMotion: Bool) -> Pose {
        let rest = Pose(scaleX: 1, scaleY: 1, offsetY: 0, rotation: 0)
        guard !reduceMotion, time >= 0, time < 0.9 else { return rest }
        let keys: [(Double, Pose)] = [
            (0, rest), (0.12, Pose(scaleX: 1.12, scaleY: 0.88, offsetY: 2, rotation: -5)),
            (0.34, Pose(scaleX: 0.94, scaleY: 1.06, offsetY: -7, rotation: 8)),
            (0.54, Pose(scaleX: 1.06, scaleY: 0.94, offsetY: 1, rotation: -3)), (0.9, rest),
        ]
        for i in 1..<keys.count where time <= keys[i].0 {
            let a = keys[i - 1], b = keys[i]
            let p = (time - a.0) / (b.0 - a.0), eased = p * p * (3 - 2 * p)
            func mix(_ x: Double, _ y: Double) -> Double { x + (y - x) * eased }
            return Pose(scaleX: mix(a.1.scaleX, b.1.scaleX), scaleY: mix(a.1.scaleY, b.1.scaleY),
                        offsetY: mix(a.1.offsetY, b.1.offsetY), rotation: mix(a.1.rotation, b.1.rotation))
        }
        return rest
    }
}
