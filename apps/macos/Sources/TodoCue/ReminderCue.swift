import Foundation
import TodoCueKit

enum CueSubject: Equatable {
    case task(TodoTask)
    case periodic(PeriodicReminder)
}

struct ReminderCue: Identifiable, Equatable {
    let id: String
    let subject: CueSubject
    var task: TodoTask? { if case .task(let value) = subject { return value }; return nil }
    var periodic: PeriodicReminder? { if case .periodic(let value) = subject { return value }; return nil }
    var title: String { task?.title ?? periodic?.title ?? "" }
    /// One stack row per task and per periodic rule.
    var key: String {
        if let task { return "task:\(task.id)" }
        if let periodic { return "periodic:\(periodic.id)" }
        return id
    }
    let count: Int
    let late: Bool
    let receivedAt: Date

    init(id: String, task: TodoTask, count: Int, late: Bool, receivedAt: Date) {
        self.id = id; subject = .task(task); self.count = count; self.late = late; self.receivedAt = receivedAt
    }
    init(periodic rule: PeriodicReminder, now: Date = Date()) {
        id = "\(rule.currentOccurrenceId ?? rule.id):\(rule.currentOccurrence?.round ?? 0)"
        subject = .periodic(rule); count = 1; late = false; receivedAt = now
    }

    static func from(_ event: RuntimeEvent, task: TodoTask, now: Date = Date()) -> ReminderCue? {
        guard event.type == .reminderFired, let id = event.id, event.related?["taskId"] == task.id,
              task.status == .todo, let at = TCDate.parse(event.at),
              now.timeIntervalSince(at) >= -5, now.timeIntervalSince(at) < 120,
              event.related?["fireAt"] == task.reminderAt else { return nil }
        return ReminderCue(id: id, task: task, count: max(1, Int(event.related?["count"] ?? "1") ?? 1),
                           late: event.related?["late"] == "true", receivedAt: at)
    }
}

/// One row of the stack: a task, or a periodic rule. A rule that fires again while it is still
/// unanswered updates its row (`repeats`) instead of adding another.
struct CueEntry: Identifiable, Equatable {
    let key: String
    var cue: ReminderCue
    /// Arrival order inside its kind. A row never moves because another one arrived or left.
    let order: Int
    var repeats = 1
    var arrivedAt: Date
    /// A periodic rule outside its active windows keeps its row but is not shown.
    var dormant = false
    var id: String { key }
    var isTask: Bool { cue.task != nil }
}

/// What the notch holds for the user to answer. Dismissing, collapsing or hiding it never changes a
/// task or a rule; a row leaves only when its reminder is handled or no longer current.
struct CueStack: Equatable {
    /// Rows shown at rest; further ones fold into a "N more" row.
    static let visibleRows = 3
    static let capacity = 20
    private static let replayWindow: TimeInterval = 300
    private static let freshness: TimeInterval = 120

    private(set) var entries: [CueEntry] = []
    private var nextOrder = 0
    private var seen: [String: Date] = [:]

    enum Outcome: Equatable { case added, merged, ignored }

    /// Time-bound task reminders above periodic ones; arrival order inside each; dormant rows left out.
    var shown: [CueEntry] {
        entries.filter { !$0.dormant }.sorted { a, b in a.isTask != b.isTask ? a.isTask : a.order < b.order }
    }
    var isEmpty: Bool { shown.isEmpty }
    func entry(_ key: String) -> CueEntry? { entries.first { $0.key == key } }

    @discardableResult
    mutating func receive(_ cue: ReminderCue, now: Date = Date()) -> Outcome {
        seen = seen.filter { now.timeIntervalSince($0.value) < Self.replayWindow }
        if let index = entries.firstIndex(where: { $0.key == cue.key }) {
            if entries[index].cue.id == cue.id {
                // The same occurrence again: take the newer snapshot, nothing else changes.
                entries[index].cue = cue
                return .ignored
            }
            guard seen[cue.id] == nil else { return .ignored }
            seen[cue.id] = now
            entries[index].cue = cue
            entries[index].repeats += 1
            entries[index].arrivedAt = now
            entries[index].dormant = false
            return .merged
        }
        guard now.timeIntervalSince(cue.receivedAt) < Self.freshness, seen[cue.id] == nil else { return .ignored }
        seen[cue.id] = now
        entries.append(CueEntry(key: cue.key, cue: cue, order: nextOrder, arrivedAt: now))
        nextOrder += 1
        if entries.count > Self.capacity {
            let drop = entries.firstIndex { !$0.isTask } ?? 0
            entries.remove(at: drop)
        }
        return .added
    }

    /// Updates a row's snapshot (a newer rule version, a delivery state) without counting a new arrival.
    mutating func refresh(_ key: String, with cue: ReminderCue) {
        guard let index = entries.firstIndex(where: { $0.key == key }) else { return }
        entries[index].cue = cue
    }

    mutating func remove(_ key: String) { entries.removeAll { $0.key == key } }

    /// Leaving a window hides the row; coming back counts as one more arrival so it lands again.
    @discardableResult
    mutating func setDormant(_ key: String, _ dormant: Bool, now: Date = Date()) -> Bool {
        guard let index = entries.firstIndex(where: { $0.key == key }), entries[index].dormant != dormant else { return false }
        entries[index].dormant = dormant
        if !dormant {
            entries[index].repeats += 1
            entries[index].arrivedAt = now
        }
        return true
    }

    mutating func clear() { entries.removeAll(); seen.removeAll() }
}

enum CueMotion {
    /// Progress of one ripple ring, 0…1, over its 1.1s life; 0 outside it.
    static func ripple(at time: TimeInterval, reduceMotion: Bool) -> Double {
        guard !reduceMotion, time > 0, time < 1.1 else { return 0 }
        let p = time / 1.1
        return 1 - pow(1 - p, 3)
    }

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
