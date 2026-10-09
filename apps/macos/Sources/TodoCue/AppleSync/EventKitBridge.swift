import AppKit
import EventKit
import TodoCueKit

enum AppleSyncAccess: Equatable {
    /// `writeOnly` can be upgraded by asking again; two-way sync cannot read edits back without full access.
    case notDetermined, writeOnly, granted, denied
}

/// The dedicated calendar or reminder list TodoCue mirrors into.
struct AppleSyncContainer: Equatable {
    var identifier: String
    var title: String
    var sourceTitle: String
    var sourceIdentifier: String
    /// False when the container lives in a local or non-iCloud account — it will not reach the phone.
    var isICloud: Bool
}

/// Where a linked item is now.
enum AppleItemLocation: Equatable {
    case here(AppleItem)
    /// Still exists, but in another calendar or made recurring — out of sync's hands, not deleted.
    case elsewhere
    case gone
}

/// Everything the sync controller needs from EventKit, behind a seam so tests can fake it.
@MainActor
protocol AppleItemStore: AnyObject {
    var onChange: (() -> Void)? { get set }
    func access(_ kind: AppleSyncKind) -> AppleSyncAccess
    func requestAccess(_ kind: AppleSyncKind) async -> Bool
    /// The stored container; else one titled `title` in the stored account (the preferred one on first
    /// use), adopted or created. Never moves to a different account once one has been used.
    func container(_ kind: AppleSyncKind, identifier: String?, sourceIdentifier: String?, title: String) throws -> AppleSyncContainer
    /// Items in the container that sync can discover (a bounded window for events).
    func items(_ kind: AppleSyncKind, in container: String) async throws -> [AppleItem]
    /// A linked item by identifier, then by external identifier, regardless of any fetch window.
    func locate(_ kind: AppleSyncKind, identifier: String, externalIdentifier: String?, in container: String) -> AppleItemLocation
    /// Create (identifier nil) or overwrite an item; returns it as read back.
    func save(_ kind: AppleSyncKind, _ snapshot: AppleItemSnapshot, timezone: String, identifier: String?,
              in container: String) throws -> AppleItem
    func delete(_ kind: AppleSyncKind, identifier: String) throws
    func removeContainer(_ kind: AppleSyncKind, identifier: String) throws
}

enum AppleSyncStoreError: LocalizedError {
    case noSource, containerMissing, accountUnavailable, fetchFailed

    var errorDescription: String? {
        switch self {
        case .noSource: return L10n.tr("找不到可用的日历账户")
        case .containerMissing: return L10n.tr("同步用的日历或列表已不存在")
        case .accountUnavailable: return L10n.tr("原来同步所用的账户当前不可用，已暂停同步。账户恢复后会自动继续；如需换账户，请先「移除同步数据」。")
        case .fetchFailed: return L10n.tr("读取提醒事项失败")
        }
    }
}

/// Resumes a continuation at most once, whichever of callback and timeout comes first.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool { lock.withLock { defer { done = true }; return !done } }
}

@MainActor
final class EventKitStore: AppleItemStore {
    private var store = EKEventStore()
    private var observer: NSObjectProtocol?
    var onChange: (() -> Void)?

    init() {
        // `object: nil`: the store is replaced after access is granted and must keep reporting.
        observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onChange?() }
        }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    private static func entity(_ kind: AppleSyncKind) -> EKEntityType { kind == .event ? .event : .reminder }

    func access(_ kind: AppleSyncKind) -> AppleSyncAccess {
        switch EKEventStore.authorizationStatus(for: Self.entity(kind)) {
        case .fullAccess: return .granted
        case .notDetermined: return .notDetermined
        case .writeOnly: return .writeOnly
        case .denied, .restricted: return .denied
        @unknown default: return .denied
        }
    }

    func requestAccess(_ kind: AppleSyncKind) async -> Bool {
        let granted: Bool
        do {
            granted = kind == .event ? try await store.requestFullAccessToEvents()
                                     : try await store.requestFullAccessToReminders()
        } catch {
            return false
        }
        // Refresh sources seen before the grant. `reset()` rather than a new store, so a fetch still
        // in flight on this store is not orphaned.
        if granted { store.reset() }
        return granted
    }

    private static func isICloud(_ source: EKSource?) -> Bool {
        source?.sourceType == .calDAV && (source?.title.localizedCaseInsensitiveContains("icloud") ?? false)
    }

    /// iCloud when it carries this kind on this Mac (that is what reaches the phone), else the account
    /// the user already writes new items to.
    private func preferredSources(_ kind: AppleSyncKind) -> [EKSource] {
        let type = Self.entity(kind)
        var result = store.sources.filter { Self.isICloud($0) && !$0.calendars(for: type).isEmpty }
        let fallback = kind == .event ? store.defaultCalendarForNewEvents?.source : store.defaultCalendarForNewReminders()?.source
        if let fallback { result.append(fallback) }
        result += store.sources.filter { $0.sourceType == .local }
        var seen = Set<String>()
        return result.filter { seen.insert($0.sourceIdentifier).inserted }
    }

    private static func info(_ calendar: EKCalendar) -> AppleSyncContainer {
        let source = calendar.source
        return AppleSyncContainer(identifier: calendar.calendarIdentifier, title: calendar.title,
                                  sourceTitle: source?.title ?? "", sourceIdentifier: source?.sourceIdentifier ?? "",
                                  isICloud: isICloud(source))
    }

    private func calendar(_ kind: AppleSyncKind, _ identifier: String) -> EKCalendar? {
        guard let calendar = store.calendar(withIdentifier: identifier),
              calendar.allowedEntityTypes.contains(kind == .event ? .event : .reminder) else { return nil }
        return calendar
    }

    func container(_ kind: AppleSyncKind, identifier: String?, sourceIdentifier: String?, title: String) throws -> AppleSyncContainer {
        if let identifier, let existing = calendar(kind, identifier) { return Self.info(existing) }
        let sources: [EKSource]
        if let sourceIdentifier {
            // Signed out of iCloud, or iCloud Calendars switched off: wait for it rather than quietly
            // starting over in another account the phone never sees.
            guard let source = store.sources.first(where: { $0.sourceIdentifier == sourceIdentifier }) else {
                throw AppleSyncStoreError.accountUnavailable
            }
            sources = [source]
        } else {
            sources = preferredSources(kind)
        }
        guard !sources.isEmpty else { throw AppleSyncStoreError.noSource }
        var lastError: Error = AppleSyncStoreError.noSource
        for source in sources {
            // Re-adopt a container left by an earlier install instead of creating a twin.
            if let existing = store.calendars(for: Self.entity(kind))
                .first(where: { $0.title == title && $0.source?.sourceIdentifier == source.sourceIdentifier }) {
                return Self.info(existing)
            }
            let calendar = EKCalendar(for: Self.entity(kind), eventStore: store)
            calendar.title = title
            calendar.source = source
            calendar.cgColor = NSColor.systemTeal.cgColor
            do {
                try store.saveCalendar(calendar, commit: true)
                return Self.info(calendar)
            } catch {
                lastError = error // some accounts (Google, Exchange) refuse new calendars; try the next
            }
        }
        throw lastError
    }

    func items(_ kind: AppleSyncKind, in container: String) async throws -> [AppleItem] {
        guard let calendar = calendar(kind, container) else { throw AppleSyncStoreError.containerMissing }
        switch kind {
        case .event:
            // EventKit caps a predicate at four years; linked events outside it are fetched by id.
            let now = Date()
            let predicate = store.predicateForEvents(withStart: now.addingTimeInterval(-365 * 86_400),
                                                     end: now.addingTimeInterval(3 * 365 * 86_400), calendars: [calendar])
            var seen = Set<String>()
            return store.events(matching: predicate).compactMap { event in
                guard !event.hasRecurrenceRules, seen.insert(event.calendarItemIdentifier).inserted else { return nil }
                return Self.item(event)
            }
        case .reminder:
            let predicate = store.predicateForReminders(in: [calendar])
            let store = store
            return try await withCheckedThrowingContinuation { continuation in
                let once = Once()
                let request = store.fetchReminders(matching: predicate) { reminders in
                    guard once.claim() else { return }
                    // nil is a failed fetch, not an empty list — reading it as empty would make every
                    // linked reminder look deleted.
                    guard let reminders else { return continuation.resume(throwing: AppleSyncStoreError.fetchFailed) }
                    continuation.resume(returning: reminders.filter { !$0.hasRecurrenceRules }.map(EventKitStore.item))
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
                    guard once.claim() else { return }
                    store.cancelFetchRequest(request)
                    continuation.resume(throwing: AppleSyncStoreError.fetchFailed)
                }
            }
        }
    }

    func locate(_ kind: AppleSyncKind, identifier: String, externalIdentifier: String?, in container: String) -> AppleItemLocation {
        let type = Self.entity(kind)
        var found = store.calendarItem(withIdentifier: identifier)
        if found == nil, let externalIdentifier {
            let matches = store.calendarItems(withExternalIdentifier: externalIdentifier)
                .filter { $0.calendar?.allowedEntityTypes.contains(type == .event ? .event : .reminder) ?? false }
            found = matches.first { $0.calendar?.calendarIdentifier == container } ?? matches.first
        }
        guard let found else { return .gone }
        guard found.calendar?.calendarIdentifier == container, !found.hasRecurrenceRules else { return .elsewhere }
        if kind == .event, let event = found as? EKEvent { return .here(Self.item(event)) }
        if kind == .reminder, let reminder = found as? EKReminder { return .here(Self.item(reminder)) }
        return .elsewhere
    }

    func save(_ kind: AppleSyncKind, _ snapshot: AppleItemSnapshot, timezone: String, identifier: String?,
              in container: String) throws -> AppleItem {
        guard let calendar = calendar(kind, container) else { throw AppleSyncStoreError.containerMissing }
        let existing = identifier.flatMap { store.calendarItem(withIdentifier: $0) }
        switch kind {
        case .event:
            let event = (existing as? EKEvent) ?? EKEvent(eventStore: store)
            let isNew = existing == nil
            event.calendar = calendar
            event.title = snapshot.title
            event.notes = snapshot.notes
            event.url = snapshot.url.flatMap(URL.init(string:))
            switch snapshot.start {
            case .day(let d)?:
                let start = TCDate.parseLocalDate(d) ?? Date()
                var endDay = start
                if case .day(let e)? = snapshot.end, let parsed = TCDate.parseLocalDate(e), parsed >= start { endDay = parsed }
                event.isAllDay = true
                event.timeZone = nil
                event.startDate = start
                // EventKit's own all-day ends sit on the last second of the last day.
                event.endDate = (Calendar.current.date(byAdding: .day, value: 1, to: endDay) ?? endDay).addingTimeInterval(-1)
            case .instant(let i)?:
                let start = TCDate.parse(i) ?? Date()
                event.isAllDay = false
                event.timeZone = TimeZone(identifier: timezone)
                event.startDate = start
                event.endDate = snapshot.end?.date ?? start.addingTimeInterval(TimeInterval(AppleSyncMapper.defaultEventMinutes * 60))
            case nil:
                break
            }
            // No alerts: TodoCue already reminds on the Mac. Calendar's default alert would double it.
            if isNew { event.alarms = nil }
            try store.save(event, span: .thisEvent, commit: true)
            return Self.item(event)
        case .reminder:
            let reminder = (existing as? EKReminder) ?? EKReminder(eventStore: store)
            reminder.calendar = calendar
            reminder.title = snapshot.title
            reminder.notes = snapshot.notes
            reminder.url = snapshot.url.flatMap(URL.init(string:))
            reminder.priority = snapshot.priority
            reminder.dueDateComponents = Self.components(snapshot.due, timezone: timezone)
            // Re-setting it would restamp the completion date to now.
            if reminder.isCompleted != snapshot.isCompleted { reminder.isCompleted = snapshot.isCompleted }
            try store.save(reminder, commit: true)
            return Self.item(reminder)
        }
    }

    func delete(_ kind: AppleSyncKind, identifier: String) throws {
        guard let item = store.calendarItem(withIdentifier: identifier) else { return }
        if let event = item as? EKEvent { try store.remove(event, span: .thisEvent, commit: true) }
        else if let reminder = item as? EKReminder { try store.remove(reminder, commit: true) }
    }

    func removeContainer(_ kind: AppleSyncKind, identifier: String) throws {
        guard let calendar = calendar(kind, identifier) else { return }
        try store.removeCalendar(calendar, commit: true)
    }

    // MARK: - Conversion

    nonisolated static func item(_ event: EKEvent) -> AppleItem {
        AppleItem(identifier: event.calendarItemIdentifier, externalIdentifier: event.calendarItemExternalIdentifier,
                  snapshot: snapshot(event))
    }

    nonisolated static func item(_ reminder: EKReminder) -> AppleItem {
        AppleItem(identifier: reminder.calendarItemIdentifier, externalIdentifier: reminder.calendarItemExternalIdentifier,
                  snapshot: snapshot(reminder))
    }

    nonisolated static func snapshot(_ event: EKEvent) -> AppleItemSnapshot {
        let start: AppleDateValue?
        let end: AppleDateValue?
        if event.isAllDay {
            start = event.startDate.map { .day(TCDate.localDateString($0)) }
            // All-day ends land on 23:59:59 or the next midnight depending on origin; step back a second.
            end = event.endDate.map { end in
                .day(TCDate.localDateString(max(event.startDate ?? end, end.addingTimeInterval(-1))))
            }
        } else {
            start = event.startDate.map(AppleDateValue.at)
            end = event.endDate.map(AppleDateValue.at)
        }
        return AppleItemSnapshot(title: event.title ?? "", notes: event.notes, start: start, end: end,
                                 url: event.url?.absoluteString)
    }

    nonisolated static func snapshot(_ reminder: EKReminder) -> AppleItemSnapshot {
        AppleItemSnapshot(title: reminder.title ?? "", notes: reminder.notes, due: value(reminder.dueDateComponents),
                          priority: reminder.priority, isCompleted: reminder.isCompleted,
                          url: reminder.url?.absoluteString)
    }

    nonisolated static func value(_ components: DateComponents?) -> AppleDateValue? {
        guard let c = components, let year = c.year, let month = c.month, let day = c.day else { return nil }
        guard c.hour != nil else { return .day(String(format: "%04d-%02d-%02d", year, month, day)) }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = c.timeZone ?? .current
        var exact = c
        exact.calendar = nil
        return calendar.date(from: exact).map(AppleDateValue.at)
    }

    nonisolated static func components(_ value: AppleDateValue?, timezone: String) -> DateComponents? {
        switch value {
        case .day(let d)?:
            guard let civil = CivilDate.parse(d) else { return nil }
            return DateComponents(calendar: Calendar(identifier: .gregorian), year: civil.year, month: civil.month, day: civil.day)
        case .instant(let i)?:
            guard let date = TCDate.parse(i) else { return nil }
            let zone = TimeZone(identifier: timezone) ?? .current
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = zone
            var c = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
            c.calendar = calendar
            c.timeZone = zone
            return c
        case nil:
            return nil
        }
    }
}
