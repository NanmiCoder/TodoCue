import Foundation

/// Which Apple surface a task is mirrored to. Each has its own container, links and switch.
public enum AppleSyncKind: String, Codable, CaseIterable, Sendable {
    case event, reminder
}

/// A local day (all-day item) or an exact instant, the two shapes a TodoCue date field can take.
public enum AppleDateValue: Codable, Hashable, Sendable {
    case day(String)
    case instant(String)

    /// Instants compare at minute precision: EventKit and the runtime round differently below that.
    public static func at(_ date: Date) -> AppleDateValue {
        .instant(TCDate.iso(Date(timeIntervalSince1970: (date.timeIntervalSince1970 / 60).rounded(.down) * 60)))
    }

    public static func at(_ iso: String) -> AppleDateValue? { TCDate.parse(iso).map(at) }

    public var date: Date? {
        switch self {
        case .day(let d): return TCDate.parseLocalDate(d)
        case .instant(let i): return TCDate.parse(i)
        }
    }
}

/// EventKit-free description of a calendar event or reminder — the unit of comparison for sync.
public struct AppleItemSnapshot: Codable, Hashable, Sendable {
    public var title: String
    public var notes: String?
    /// Events: start; all-day events carry `.day`.
    public var start: AppleDateValue?
    /// Events: end — the last day (inclusive) for all-day events, an instant otherwise.
    public var end: AppleDateValue?
    /// Reminders: due date.
    public var due: AppleDateValue?
    /// Reminders: EventKit priority (0 none, 1 high … 9 low).
    public var priority: Int
    public var isCompleted: Bool
    public var url: String?

    public init(title: String, notes: String? = nil, start: AppleDateValue? = nil, end: AppleDateValue? = nil,
                due: AppleDateValue? = nil, priority: Int = 0, isCompleted: Bool = false, url: String? = nil) {
        self.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        self.notes = AppleSyncMapper.normalizedNotes(notes)
        self.start = start; self.end = end; self.due = due
        self.priority = priority; self.isCompleted = isCompleted; self.url = url
    }

    /// The TodoCue task id this item points back to through its `todocue://task/<id>` URL.
    public var linkedTaskId: String? { url.flatMap(AppleSyncMapper.taskId(fromURL:)) }
}

/// One item as read from EventKit.
public struct AppleItem: Hashable, Sendable {
    public var identifier: String
    /// The server-side id. `calendarItemIdentifier` is documented not to survive a full resync; this
    /// is the second way back to the same item.
    public var externalIdentifier: String?
    public var snapshot: AppleItemSnapshot

    public init(identifier: String, externalIdentifier: String? = nil, snapshot: AppleItemSnapshot) {
        self.identifier = identifier; self.externalIdentifier = externalIdentifier; self.snapshot = snapshot
    }
}

/// A task ↔ item pairing, with what each side looked like when the two last agreed.
public struct AppleSyncLink: Codable, Hashable, Sendable {
    public var kind: AppleSyncKind
    public var taskId: String
    public var identifier: String
    public var externalIdentifier: String?
    /// Task version at the last sync — only used to recognise a board older than this app's own write.
    public var taskVersion: Int
    /// The item as read back right after the last sync. Anything else means it was edited in Apple's apps.
    public var lastSnapshot: AppleItemSnapshot?
    /// What TodoCue wanted the item to be at the last sync. A different `desired` now means TodoCue
    /// changed something the item shows — unlike `version`, which also moves for project, snooze, order…
    public var lastDesired: AppleItemSnapshot?
    /// When the item was first found missing. Deletion is only believed after a grace period.
    public var missingSince: String?
    /// Set when the item still exists but left sync (moved to another calendar, made recurring).
    /// A detached task is left alone instead of being cancelled or re-created.
    public var detachedAt: String?

    public init(kind: AppleSyncKind, taskId: String, identifier: String, externalIdentifier: String? = nil,
                taskVersion: Int, lastSnapshot: AppleItemSnapshot?, lastDesired: AppleItemSnapshot? = nil) {
        self.kind = kind; self.taskId = taskId; self.identifier = identifier
        self.externalIdentifier = externalIdentifier
        self.taskVersion = taskVersion; self.lastSnapshot = lastSnapshot; self.lastDesired = lastDesired
    }
}

/// Which TodoCue field pair an item's date stands for.
public enum AppleSyncAnchor: Sendable, Equatable {
    case scheduled, due

    var dateKey: String { self == .scheduled ? "scheduledDate" : "dueDate" }
    var instantKey: String { self == .scheduled ? "scheduledAt" : "dueAt" }
}

/// Pure task ⇄ item translation.
public enum AppleSyncMapper {
    public static let defaultEventMinutes = 30
    public static let urlPrefix = "todocue://task/"

    public static func url(for taskId: String) -> String { urlPrefix + taskId }

    public static func taskId(fromURL url: String) -> String? {
        guard url.hasPrefix(urlPrefix) else { return nil }
        let id = String(url.dropFirst(urlPrefix.count))
        // Ids go into an API path; anything beyond the runtime's own alphabet is not ours.
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        guard !id.isEmpty, id.count <= 64, id.unicodeScalars.allSatisfy({ allowed.contains($0) && $0.isASCII }) else { return nil }
        return id
    }

    static func normalizedNotes(_ notes: String?) -> String? {
        guard let notes, !notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return notes
    }

    static func value(_ task: TodoTask, _ anchor: AppleSyncAnchor) -> AppleDateValue? {
        switch anchor {
        case .scheduled:
            if let at = task.scheduledAt { return AppleDateValue.at(at) }
            return task.scheduledDate.map(AppleDateValue.day)
        case .due:
            if let at = task.dueAt { return AppleDateValue.at(at) }
            return task.dueDate.map(AppleDateValue.day)
        }
    }

    /// Events show the plan; a deadline stands in only when there is no plan (mirrors `planDate`).
    /// Reminders show the deadline; the plan stands in only when there is no deadline, and an
    /// undated task maps its reminder date onto the plan.
    public static func anchor(for task: TodoTask, kind: AppleSyncKind) -> AppleSyncAnchor {
        switch kind {
        case .event: return value(task, .scheduled) != nil || value(task, .due) == nil ? .scheduled : .due
        case .reminder: return value(task, .due) != nil ? .due : .scheduled
        }
    }

    /// True when a todo task should get an item it does not have yet.
    public static func isInScope(_ task: TodoTask) -> Bool {
        task.status == .todo && (value(task, .scheduled) != nil || value(task, .due) != nil)
    }

    public static func eventMinutes(_ task: TodoTask) -> Int {
        if let m = task.estimateMinutes, m > 0 { return m }
        return defaultEventMinutes
    }

    /// What the item for this task should look like. Nil when the kind cannot represent the task
    /// (an event needs a date).
    public static func snapshot(for task: TodoTask, kind: AppleSyncKind) -> AppleItemSnapshot? {
        let anchor = anchor(for: task, kind: kind)
        let value = value(task, anchor)
        switch kind {
        case .event:
            guard let value else { return nil }
            let end: AppleDateValue
            switch value {
            case .day: end = value
            case .instant(let i):
                let start = TCDate.parse(i) ?? Date()
                end = .at(start.addingTimeInterval(TimeInterval(eventMinutes(task) * 60)))
            }
            return AppleItemSnapshot(title: task.title, notes: task.notes, start: value, end: end, url: url(for: task.id))
        case .reminder:
            return AppleItemSnapshot(title: task.title, notes: task.notes, due: value, priority: priority(task.priority),
                                     isCompleted: task.status == .done, url: url(for: task.id))
        }
    }

    public static func priority(_ p: Priority) -> Int {
        switch p { case .none: return 0; case .high: return 1; case .medium: return 5; case .low: return 9 }
    }

    public static func priority(_ ek: Int) -> Priority {
        switch ek {
        case 1...4: return .high
        case 5: return .medium
        case 6...9: return .low
        default: return .none
        }
    }

    private static func setDate(_ value: AppleDateValue?, anchor: AppleSyncAnchor, into p: inout TaskPayload) {
        switch value {
        case .day(let d)?:
            p.set(anchor.dateKey, d); p.set(anchor.instantKey, nil as String?)
        case .instant(let i)?:
            p.set(anchor.instantKey, i); p.set(anchor.dateKey, nil as String?)
        case nil:
            p.set(anchor.dateKey, nil as String?); p.set(anchor.instantKey, nil as String?)
        }
    }

    /// Field changes that bring the task in line with an item edited in Apple's apps. Status
    /// (a reminder's checkbox) is handled separately by the caller.
    public static func patch(from item: AppleItemSnapshot, task: TodoTask, kind: AppleSyncKind) -> TaskPayload {
        var p = TaskPayload()
        if !item.title.isEmpty, item.title != task.title.trimmingCharacters(in: .whitespacesAndNewlines) {
            p.set("title", item.title)
        }
        if item.notes != normalizedNotes(task.notes) { p.set("notes", item.notes) }
        let anchor = anchor(for: task, kind: kind)
        let current = value(task, anchor)
        switch kind {
        case .event:
            // An event cannot lose its date, so only a different one is a change.
            if let start = item.start, start != current { setDate(start, anchor: anchor, into: &p) }
            if case .instant(let s)? = item.start, case .instant(let e)? = item.end,
               let sd = TCDate.parse(s), let ed = TCDate.parse(e) {
                let minutes = Int((ed.timeIntervalSince(sd) / 60).rounded())
                if minutes > 0, minutes != eventMinutes(task) { p.set("estimateMinutes", minutes) }
            }
        case .reminder:
            if item.due != current { setDate(item.due, anchor: anchor, into: &p) }
            let priority = priority(item.priority)
            if priority != task.priority { p.set("priority", priority.rawValue) }
        }
        return p
    }

    /// Three-way merge per field group: a group takes the item's value only when Apple changed it since
    /// the last sync and TodoCue did not; otherwise TodoCue's. Feeding the result to `patch` therefore
    /// writes back exactly the edits made on Apple's side that do not collide with TodoCue's own.
    /// Without a baseline (adopted items) TodoCue wins everything.
    public static func merged(item: AppleItemSnapshot, baseline: AppleItemSnapshot?, desired: AppleItemSnapshot,
                              lastDesired: AppleItemSnapshot?) -> AppleItemSnapshot {
        func appleChanged(_ same: (AppleItemSnapshot, AppleItemSnapshot) -> Bool) -> Bool {
            baseline.map { !same(item, $0) } ?? true
        }
        func todoChanged(_ same: (AppleItemSnapshot, AppleItemSnapshot) -> Bool) -> Bool {
            lastDesired.map { !same(desired, $0) } ?? true
        }
        func takeItem(_ same: @escaping (AppleItemSnapshot, AppleItemSnapshot) -> Bool) -> Bool {
            appleChanged(same) && !todoChanged(same)
        }
        var m = desired
        if takeItem({ $0.title == $1.title }) { m.title = item.title }
        if takeItem({ $0.notes == $1.notes }) { m.notes = item.notes }
        if takeItem({ $0.start == $1.start && $0.end == $1.end }) { m.start = item.start; m.end = item.end }
        if takeItem({ $0.due == $1.due }) { m.due = item.due }
        if takeItem({ $0.priority == $1.priority }) { m.priority = item.priority }
        if takeItem({ $0.isCompleted == $1.isCompleted }) { m.isCompleted = item.isCompleted }
        return m
    }

    /// Body for a task created from an item the user added in Apple's apps.
    public static func createPayload(from item: AppleItemSnapshot, kind: AppleSyncKind) -> TaskPayload {
        var p = TaskPayload()
        p.set("title", item.title.isEmpty ? L10n.tr("未命名任务") : item.title)
        p.setIfPresent("notes", item.notes)
        switch kind {
        case .event:
            switch item.start {
            case .day(let d)?: p.set("scheduledDate", d)
            case .instant(let i)?:
                p.set("scheduledAt", i)
                if case .instant(let e)? = item.end, let sd = TCDate.parse(i), let ed = TCDate.parse(e) {
                    let minutes = Int((ed.timeIntervalSince(sd) / 60).rounded())
                    if minutes > 0 { p.set("estimateMinutes", minutes) }
                }
            case nil: break
            }
        case .reminder:
            switch item.due {
            case .day(let d)?: p.set("scheduledDate", d)
            case .instant(let i)?: p.set("scheduledAt", i)
            case nil: break
            }
            let priority = priority(item.priority)
            if priority != .none { p.set("priority", priority.rawValue) }
        }
        return p
    }
}

/// One step of a sync round. Executed in order by the app; the planner itself never touches EventKit.
public enum AppleSyncAction: Hashable, Sendable {
    /// Make a new item for a task that has none.
    case create(taskId: String)
    /// TodoCue changed (or both did — TodoCue wins): overwrite the item.
    case push(taskId: String, identifier: String)
    /// The item was edited in Apple's apps: write it back to the task.
    case pull(taskId: String, identifier: String)
    /// The task left the kind's scope: remove the item and the link.
    case deleteItem(taskId: String, identifier: String)
    /// The item was deleted in Apple's apps: cancel the task and drop the link.
    case cancelTask(taskId: String)
    /// Forget the link without touching either side.
    case unlink(taskId: String)
    /// The link's item changed identity (iCloud resync); point the link at it.
    case relink(taskId: String, identifier: String)
    /// Both sides already agree: record the current task version and item as the new baseline.
    case markSynced(taskId: String, identifier: String)
    /// The item is gone for the first time: remember when, act only if it stays gone.
    case markMissing(taskId: String)
    /// The item still exists outside sync (other calendar, recurring): stop managing the task here.
    case detach(taskId: String)
    /// An unlinked item points at a task through its URL: link it and let TodoCue win.
    case adopt(taskId: String, identifier: String)
    /// An item added in Apple's apps: create a TodoCue task for it.
    case importItem(identifier: String)
}

public enum AppleSyncPlanner {
    /// How long a completed reminder stays linked to its done task.
    public static let completedRetention: TimeInterval = 30 * 86_400
    /// How long an item must stay missing before its task is cancelled. An iCloud resync can make
    /// items vanish briefly; a deletion on the phone is still a deletion ten minutes later.
    public static let missingGrace: TimeInterval = 10 * 60

    /// Plan one round for one kind.
    /// - Parameters:
    ///   - tasks: every todo task plus every linked or URL-referenced task that could be fetched.
    ///     A linked task missing here no longer exists.
    ///   - links: this kind's links.
    ///   - items: every item in this kind's container, including linked ones outside any fetch window.
    ///   - departed: identifiers of linked items that still exist but no longer qualify for sync.
    public static func plan(kind: AppleSyncKind, tasks: [String: TodoTask], links: [AppleSyncLink],
                            items: [AppleItem], departed: Set<String> = [], now: Date = Date()) -> [AppleSyncAction] {
        var actions: [AppleSyncAction] = []
        let itemsById = Dictionary(items.map { ($0.identifier, $0) }, uniquingKeysWith: { a, _ in a })
        let linkedIds = Set(links.map(\.identifier))
        let linkedTaskIds = Set(links.map(\.taskId))
        var claimed = Set<String>()
        func free(_ item: AppleItem) -> Bool { !claimed.contains(item.identifier) && !linkedIds.contains(item.identifier) }

        for link in links {
            let task = tasks[link.taskId]
            var item = itemsById[link.identifier]
            if item == nil {
                // Same item under a new identifier: server id first, then our URL, then an exact
                // match of the last baseline (Reminders does not reliably keep the URL).
                let wantsOpen = task?.status != .done
                let pool = items.filter(free)
                let candidates = pool.filter { $0.snapshot.isCompleted != wantsOpen } + pool.filter { $0.snapshot.isCompleted == wantsOpen }
                item = candidates.first { link.externalIdentifier != nil && $0.externalIdentifier == link.externalIdentifier }
                    ?? candidates.first { $0.snapshot.linkedTaskId == link.taskId
                                          && (!wantsOpen || !$0.snapshot.isCompleted) }
                    ?? link.lastSnapshot.flatMap { baseline in candidates.first { $0.snapshot == baseline } }
                if let item { actions.append(.relink(taskId: link.taskId, identifier: item.identifier)) }
            }
            if let item { claimed.insert(item.identifier) }

            guard let task else {
                if let item { actions.append(.deleteItem(taskId: link.taskId, identifier: item.identifier)) }
                else { actions.append(.unlink(taskId: link.taskId)) }
                continue
            }
            guard let item else {
                if task.status != .todo {
                    actions.append(.unlink(taskId: task.id))
                } else if link.detachedAt != nil {
                    if !departed.contains(link.identifier) { actions.append(.unlink(taskId: task.id)) }
                } else if departed.contains(link.identifier) {
                    actions.append(.detach(taskId: task.id))
                } else if let since = link.missingSince.flatMap(TCDate.parse) {
                    if now.timeIntervalSince(since) >= missingGrace { actions.append(.cancelTask(taskId: task.id)) }
                } else {
                    actions.append(.markMissing(taskId: task.id))
                }
                continue
            }

            // Versions only grow: an older one is a board that predates this app's own last write.
            // Acting on it would push stale fields back over the edit that was just pulled in.
            if task.version < link.taskVersion { continue }

            switch (kind, task.status) {
            case (_, .cancelled), (_, .skipped), (.event, .done):
                actions.append(.deleteItem(taskId: task.id, identifier: item.identifier))
                continue
            case (.reminder, .done), (_, .todo):
                break
            }
            guard let desired = AppleSyncMapper.snapshot(for: task, kind: kind) else {
                actions.append(.deleteItem(taskId: task.id, identifier: item.identifier)) // event lost its date
                continue
            }
            let appleChanged = item.snapshot != link.lastSnapshot
            let todoChanged = desired != link.lastDesired
            let stale = link.missingSince != nil || link.detachedAt != nil
            if appleChanged {
                actions.append(.pull(taskId: task.id, identifier: item.identifier))
            } else if todoChanged && item.snapshot != desired {
                actions.append(.push(taskId: task.id, identifier: item.identifier))
            } else if todoChanged || stale || task.version != link.taskVersion {
                actions.append(.markSynced(taskId: task.id, identifier: item.identifier))
            } else if task.status == .done, item.snapshot.isCompleted,
                      let done = task.completedAt.flatMap(TCDate.parse), now.timeIntervalSince(done) > completedRetention {
                actions.append(.unlink(taskId: task.id))
            }
        }

        // Unlinked items: adopt by URL, or import what the user added on their phone.
        var adopted = Set<String>()
        for item in items where free(item) {
            if item.snapshot.isCompleted { continue } // history, not something to act on
            if let taskId = item.snapshot.linkedTaskId {
                guard let task = tasks[taskId], !linkedTaskIds.contains(taskId), !adopted.contains(taskId),
                      task.status == .todo else { continue }
                adopted.insert(taskId)
                actions.append(.adopt(taskId: taskId, identifier: item.identifier))
            } else {
                actions.append(.importItem(identifier: item.identifier))
            }
        }

        // New in-scope tasks.
        for task in tasks.values.sorted(by: { $0.createdAt < $1.createdAt })
        where !linkedTaskIds.contains(task.id) && !adopted.contains(task.id) && AppleSyncMapper.isInScope(task) {
            actions.append(.create(taskId: task.id))
        }
        return actions
    }
}
