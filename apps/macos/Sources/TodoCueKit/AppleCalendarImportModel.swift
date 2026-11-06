import Foundation

/// A calendar import may read events from: any of the user's own event calendars except TodoCue's.
public struct AppleCalendarInfo: Codable, Hashable, Sendable {
    public var identifier: String
    public var title: String
    public var sourceTitle: String
    /// `#RRGGBB`, for the dot beside the name in settings.
    public var color: String?

    public init(identifier: String, title: String, sourceTitle: String, color: String? = nil) {
        self.identifier = identifier; self.title = title; self.sourceTitle = sourceTitle; self.color = color
    }
}

/// An event as read from another calendar.
public struct AppleSourceEvent: Hashable, Sendable {
    public var calendarId: String
    public var item: AppleItem
    /// Recurring events are never imported, and one made recurring leaves import.
    public var isRecurring: Bool

    public init(calendarId: String, item: AppleItem, isRecurring: Bool = false) {
        self.calendarId = calendarId; self.item = item; self.isRecurring = isRecurring
    }
}

/// One event imported from another calendar into a task. Import is one way: the event is read, never written.
public struct AppleCalendarImport: Codable, Hashable, Sendable {
    public var calendarId: String
    public var identifier: String
    public var externalIdentifier: String?
    public var taskId: String
    /// Task version after import's own last write — a board older than this predates it.
    public var taskVersion: Int
    /// The event as last read. A different one means it was edited in its calendar.
    public var lastSnapshot: AppleItemSnapshot
    /// The task, as an event, after import's last write. A field that differs now was edited in TodoCue,
    /// and TodoCue keeps it: later edits to that field in the calendar are not carried over.
    public var lastDesired: AppleItemSnapshot?
    /// When the event was first found missing. The task is cancelled only after a grace period.
    public var missingSince: String?
    /// Not followed for now: the task was finished with (completed, cancelled, deleted) or the event left
    /// import. The record still claims its event, so it is never imported twice, and keeps the task out of
    /// the TodoCue calendar. Following resumes when the task is a todo again and the event is back in an
    /// included calendar. Dropped once the event is over and the task is no longer a todo.
    public var closedAt: String?
    /// Import itself cancelled the task because its event disappeared; if the event comes back, so does the task.
    public var cancelledByImport: Bool?

    public init(calendarId: String, identifier: String, externalIdentifier: String? = nil, taskId: String,
                taskVersion: Int, lastSnapshot: AppleItemSnapshot, lastDesired: AppleItemSnapshot? = nil) {
        self.calendarId = calendarId; self.identifier = identifier; self.externalIdentifier = externalIdentifier
        self.taskId = taskId; self.taskVersion = taskVersion
        self.lastSnapshot = lastSnapshot; self.lastDesired = lastDesired
    }
}

/// Where an imported record's event is now, as the controller found it.
public enum AppleImportLocation: Hashable, Sendable {
    case here(AppleSourceEvent)
    /// Still exists, but in an excluded or TodoCue calendar, or made recurring: no longer imported.
    case elsewhere
    case gone
    /// Its calendar cannot be read at all (account signed out, calendar removed): nothing can be judged.
    case unavailable
}

public enum AppleImportAction: Hashable, Sendable {
    /// A new event: create a task for it.
    case importEvent(AppleSourceEvent)
    /// The event was edited in its calendar: carry the edit into the task.
    case pull(taskId: String, event: AppleSourceEvent)
    /// Nothing to write, but the record must follow the event (new identifier, back after missing).
    /// Only identity and the missing mark change: the baselines stay, so a pending edit is still pulled.
    case settle(taskId: String, event: AppleSourceEvent)
    case markMissing(taskId: String)
    /// The event stayed gone past the grace period: cancel the task (it stays reopenable).
    case cancelTask(taskId: String)
    /// Stop following the event; keep the record so it is not imported again.
    case close(taskId: String)
    /// Follow the event again (the task is a todo again, or the event is back in an included calendar).
    /// Any edit made meanwhile is pulled by the actions that follow it.
    case resume(taskId: String, event: AppleSourceEvent)
    /// The event import cancelled the task for is back: reopen the task and follow it again.
    case restoreTask(taskId: String, event: AppleSourceEvent)
    case forget(taskId: String)
}

public enum AppleCalendarImportPlanner {
    /// How long an event must stay missing before its task is cancelled (same as the mirror's grace).
    public static let missingGrace: TimeInterval = AppleSyncPlanner.missingGrace
    /// How far ahead new events are looked for.
    public static let horizon: TimeInterval = 365 * 86_400

    /// TodoCue's own calendars — this data's and an isolated `TODOCUE_HOME`'s ("TodoCue (tmp.x1y2)").
    public static func isTodoCueCalendar(title: String) -> Bool {
        title == "TodoCue" || title.hasPrefix("TodoCue (")
    }

    /// True while the event has not ended. An all-day event lasts through its last day.
    public static func isUpcoming(_ snapshot: AppleItemSnapshot, now: Date) -> Bool {
        switch snapshot.end ?? snapshot.start {
        case .day(let d)?:
            guard let day = TCDate.parseLocalDate(d), let after = Calendar.current.date(byAdding: .day, value: 1, to: day) else { return false }
            return after > now
        case .instant(let i)?:
            return (TCDate.parse(i) ?? .distantPast) > now
        case nil:
            return false
        }
    }

    /// The task as its event would look, for comparing with what import last wrote.
    public static func desired(for task: TodoTask) -> AppleItemSnapshot {
        AppleSyncMapper.snapshot(for: task, kind: .event) ?? AppleItemSnapshot(title: task.title, notes: task.notes)
    }

    /// The new `lastDesired` after a write: a field TodoCue had edited keeps reading as edited, so the
    /// calendar never takes it back; every other field follows the task as it now is.
    public static func baseline(after task: AppleItemSnapshot, desiredBefore: AppleItemSnapshot,
                                lastDesired: AppleItemSnapshot?) -> AppleItemSnapshot {
        guard let lastDesired else { return task }
        var b = task
        if desiredBefore.title != lastDesired.title { b.title = lastDesired.title }
        if desiredBefore.notes != lastDesired.notes { b.notes = lastDesired.notes }
        if desiredBefore.start != lastDesired.start || desiredBefore.end != lastDesired.end {
            b.start = lastDesired.start; b.end = lastDesired.end
        }
        return b
    }

    /// Plan one import round.
    /// - Parameters:
    ///   - records: every import record, open and closed.
    ///   - locations: where each record's event is now, by task id. A record without an entry is
    ///     treated as `unavailable`.
    ///   - candidates: events in the included calendars, as found this round.
    ///   - tasks: todo tasks, plus every open record's task (and any other the controller fetched); a
    ///     missing one was deleted, or is finished and not needed.
    public static func plan(records: [AppleCalendarImport], locations: [String: AppleImportLocation],
                            candidates: [AppleSourceEvent], tasks: [String: TodoTask], now: Date) -> [AppleImportAction] {
        var claimedIds = Set<String>()
        var claimedExternal = Set<String>()
        func claim(_ item: AppleItem) {
            claimedIds.insert(item.identifier)
            if let e = item.externalIdentifier { claimedExternal.insert(e) }
        }
        func isClaimed(_ item: AppleItem) -> Bool {
            claimedIds.contains(item.identifier) || (item.externalIdentifier.map(claimedExternal.contains) ?? false)
        }
        var resolved: [String: AppleImportLocation] = [:]
        for record in records {
            claimedIds.insert(record.identifier)
            if let e = record.externalIdentifier { claimedExternal.insert(e) }
            let location = locations[record.taskId] ?? .unavailable
            if case .here(let event) = location { claim(event.item) }
            resolved[record.taskId] = location
        }
        // A full iCloud resync can change both identifiers of an event. One the record cannot find by
        // either may be an unclaimed event in its calendar that matches the last read exactly.
        for record in records where resolved[record.taskId] == .gone {
            guard let match = candidates.first(where: { !$0.isRecurring && !isClaimed($0.item)
                && $0.calendarId == record.calendarId && $0.item.snapshot == record.lastSnapshot }) else { continue }
            claim(match.item)
            resolved[record.taskId] = .here(match)
        }

        var actions: [AppleImportAction] = []
        for record in records {
            let location = resolved[record.taskId] ?? .unavailable
            let task = tasks[record.taskId]
            if record.closedAt == nil {
                guard let task, task.status == .todo else {
                    actions.append(.close(taskId: record.taskId)) // done, cancelled, skipped or deleted in TodoCue
                    continue
                }
                actions += follow(record, task: task, location: location, now: now)
                continue
            }
            if case .here(let event) = location {
                if let task, task.status == .todo {
                    actions.append(.resume(taskId: record.taskId, event: event))
                    var open = record
                    open.closedAt = nil
                    open.missingSince = nil
                    actions += follow(open, task: task, location: location, now: now)
                    continue
                }
                if let task, task.status == .cancelled, record.cancelledByImport == true {
                    actions.append(.restoreTask(taskId: record.taskId, event: event))
                    continue
                }
            }
            // Closed: kept while it can still claim its event or keep its todo task out of the TodoCue calendar.
            let seen: AppleItemSnapshot
            if case .here(let event) = location { seen = event.item.snapshot } else { seen = record.lastSnapshot }
            if !isUpcoming(seen, now: now), task?.status != .todo {
                actions.append(.forget(taskId: record.taskId))
            } else if case .here(let event) = location, event.item.identifier != record.identifier {
                actions.append(.settle(taskId: record.taskId, event: event))
            }
        }

        for event in candidates.sorted(by: { $0.item.identifier < $1.item.identifier }) {
            let item = event.item
            guard !event.isRecurring, !isClaimed(item),
                  // A TodoCue mirror (any data directory's) is never imported back as a task.
                  item.snapshot.url.map({ !$0.hasPrefix(AppleSyncMapper.urlPrefix) }) ?? true,
                  item.snapshot.start != nil, isUpcoming(item.snapshot, now: now) else { continue }
            claim(item)
            actions.append(.importEvent(event))
        }
        return actions
    }

    /// An open record of a todo task.
    private static func follow(_ record: AppleCalendarImport, task: TodoTask, location: AppleImportLocation,
                               now: Date) -> [AppleImportAction] {
        switch location {
        case .unavailable:
            return []
        case .elsewhere:
            return [.close(taskId: record.taskId)]
        case .gone:
            guard let since = record.missingSince.flatMap(TCDate.parse) else { return [.markMissing(taskId: record.taskId)] }
            return now.timeIntervalSince(since) >= missingGrace ? [.cancelTask(taskId: record.taskId)] : []
        case .here(let event):
            // A board older than import's own last write would read as edits made in TodoCue.
            if task.version < record.taskVersion {
                return record.missingSince != nil ? [.settle(taskId: record.taskId, event: event)] : []
            }
            if event.item.snapshot != record.lastSnapshot { return [.pull(taskId: record.taskId, event: event)] }
            if record.missingSince != nil || event.item.identifier != record.identifier
                || event.item.externalIdentifier != record.externalIdentifier || event.calendarId != record.calendarId {
                return [.settle(taskId: record.taskId, event: event)]
            }
            return []
        }
    }
}
