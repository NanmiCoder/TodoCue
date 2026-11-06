import AppKit
import Combine
import CryptoKit
import TodoCueKit

/// The slice of the runtime API that sync writes through.
public protocol AppleSyncBackend: Sendable {
    func fetchTask(_ id: String) async throws -> TodoTask
    func createTask(from payload: TaskPayload, idempotencyKey: String) async throws -> TodoTask
    func updateTask(_ id: String, _ payload: TaskPayload, expectedVersion: Int?) async throws -> TodoTask
    func complete(_ id: String, expectedVersion: Int?) async throws -> TodoTask
    func reopen(_ id: String, expectedVersion: Int?) async throws -> TodoTask
    func cancel(_ id: String, expectedVersion: Int?) async throws -> TodoTask
    /// Permanently removes the task; a task that is already gone is not an error.
    func delete(_ id: String, expectedVersion: Int?) async throws
}

extension APIClient: AppleSyncBackend {
    public func fetchTask(_ id: String) async throws -> TodoTask { try await task(id).task }
    public func createTask(from payload: TaskPayload, idempotencyKey: String) async throws -> TodoTask {
        try await createTask(payload, idempotencyKey: idempotencyKey).task
    }
    public func delete(_ id: String, expectedVersion: Int?) async throws {
        try await deleteTask(id, expectedVersion: expectedVersion)
    }
}

/// Two-way mirror of TodoCue tasks into a dedicated Apple calendar and reminder list, plus a one-way
/// import of new events from the user's other calendars.
///
/// TodoCue stays the source of truth: a round reads both sides, `AppleSyncPlanner` (and
/// `AppleCalendarImportPlanner`) decide, and this class carries the plan out. Rounds are serialised;
/// triggers that arrive mid-round re-run it.
@MainActor
public final class AppleSyncController: ObservableObject {
    @Published public private(set) var access: [AppleSyncKind: AppleSyncAccess] = [:]
    @Published public private(set) var containers: [AppleSyncKind: AppleSyncContainer] = [:]
    @Published public private(set) var lastSyncAt: Date?
    @Published public private(set) var lastError: String?
    @Published public private(set) var isSyncing = false
    /// Channels whose switch is being flipped (permission prompt, first round) — the UI holds them still.
    @Published public private(set) var changing: Set<AppleSyncKind> = []
    /// Calendars import can read (TodoCue's own left out), while import is on.
    @Published public private(set) var importCalendars: [AppleCalendarInfo] = []
    /// The import switch is being flipped.
    @Published public private(set) var importChanging = false
    /// Import has no settings in the SwiftUI app, so only a client that shows them turns it on.
    public var supportsImport = false

    /// A burst of triggers is coalesced, but never for longer than this.
    static let maxDebounce: TimeInterval = 5

    private let store: AppleItemStore
    private let stateURL: URL
    private let defaults: UserDefaults
    /// Which client runs this controller ("swiftui", "desktop"); recorded in the state file.
    private let client: String
    private var state: AppleSyncState
    public var backend: () -> AppleSyncBackend?
    /// The todo tasks of a loaded board, or nil while none has arrived (nothing must be judged missing then).
    public var todoTasks: () -> [TodoTask]?
    public var now: () -> Date = Date.init
    /// While this returns a message, no round runs and the message is shown as the sync error
    /// (the desktop helper: the SwiftUI app is syncing the same data).
    public var pauseReason: () -> String? = { nil }
    private var pending: Task<Void, Never>?
    private var firstRequestAt: Date?
    private var running = false
    private var rerun = false
    private var retryLater = false
    /// Channels just switched (back) on: their first round treats missing items as stale links,
    /// never as deletions — the user may have tidied Apple's side while sync was off.
    private var resuming: Set<AppleSyncKind> = []
    private var cancellables: Set<AnyCancellable> = []

    public init(store: AppleItemStore, stateURL: URL = AppleSyncState.defaultURL,
                defaults: UserDefaults = AppleSyncPreferences.store(), client: String = "swiftui",
                backend: @escaping () -> AppleSyncBackend? = { nil }, todoTasks: @escaping () -> [TodoTask]? = { nil }) {
        self.store = store
        self.stateURL = stateURL
        self.defaults = defaults
        self.client = client
        self.backend = backend
        self.todoTasks = todoTasks
        self.state = AppleSyncState.load(from: stateURL)
        // Links written by another client (the SwiftUI app before the desktop helper, or the other way
        // round after a rollback) may be days old. Each one is marked until its item is seen again; the
        // mark is saved with the next write, so a restart, or a channel that has no access yet, keeps it.
        if state.client != client {
            for index in state.links.indices { state.links[index].inherited = true }
            state.client = client
        }
        store.onChange = { [weak self] in self?.scheduleSync() }
        refreshAccess()
    }

    /// Keeps a trigger subscription alive for as long as the controller.
    public func retain(_ cancellable: AnyCancellable) { cancellables.insert(cancellable) }

    /// Triggers every client wires the same way: a slow heartbeat, and access re-read on activation.
    public func startHeartbeat() {
        Timer.publish(every: 300, on: .main, in: .common).autoconnect()
            .sink { [weak self] _ in self?.scheduleSync() }.store(in: &cancellables)
        NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)
            .sink { [weak self] _ in self?.refreshAccess() }.store(in: &cancellables)
    }

    // MARK: - Settings

    public func isEnabled(_ kind: AppleSyncKind) -> Bool { AppleSyncPreferences.isEnabled(kind, in: defaults) }

    public var isAnyEnabled: Bool { AppleSyncKind.allCases.contains(where: isEnabled) || isImportEnabled }

    public var isImportEnabled: Bool { supportsImport && AppleSyncPreferences.isImportEnabled(in: defaults) }

    public var excludedCalendars: Set<String> { Set(AppleSyncPreferences.excludedCalendars(in: defaults).keys) }

    /// What an exclusion remembers about its calendar besides the identifier.
    static func calendarKey(_ calendar: AppleCalendarInfo) -> String { calendar.sourceTitle + "\n" + calendar.title }

    public func refreshAccess() {
        let current = Dictionary(uniqueKeysWithValues: AppleSyncKind.allCases.map { ($0, store.access($0)) })
        if current != access { access = current }
        refreshCalendars()
    }

    private func refreshCalendars() {
        let mirror = state.calendarId
        let current = isImportEnabled ? store.eventCalendars()
            .filter { $0.identifier != mirror && !AppleCalendarImportPlanner.isTodoCueCalendar(title: $0.title) }
            .sorted { ($0.sourceTitle, $0.title, $0.identifier) < ($1.sourceTitle, $1.title, $1.identifier) } : []
        if current != importCalendars { importCalendars = current }
        guard !current.isEmpty else { return }
        // EventKit may hand a calendar a new identifier after a full sync. An exclusion whose calendar is
        // gone passes to a never-seen calendar with the same account and name, so it is not imported
        // wholesale as if it were new.
        let ids = Set(current.map(\.identifier))
        let seen = AppleSyncPreferences.seenCalendars(in: defaults)
        var excluded = AppleSyncPreferences.excludedCalendars(in: defaults)
        var moved = false
        for calendar in current where excluded[calendar.identifier] == nil && !seen.contains(calendar.identifier) {
            let key = Self.calendarKey(calendar)
            guard let old = excluded.first(where: { !ids.contains($0.key) && $0.value == key })?.key else { continue }
            excluded[old] = nil
            excluded[calendar.identifier] = key
            moved = true
        }
        if moved {
            AppleSyncPreferences.setExcludedCalendars(excluded, in: defaults)
            objectWillChange.send()
        }
        if !ids.isSubset(of: seen) { AppleSyncPreferences.setSeenCalendars(seen.union(ids), in: defaults) }
    }

    /// Asks macOS for full access when it still can. Returns the message to show when access is missing.
    private func ensureAccess(_ kind: AppleSyncKind) async -> String? {
        let before = store.access(kind)
        if before == .notDetermined || before == .writeOnly {
            // The settings panel does not activate the app; a prompt behind other windows goes unseen.
            NSApp?.activate()
            _ = await store.requestAccess(kind)
        }
        refreshAccess()
        guard store.access(kind) == .granted else {
            return kind == .event ? L10n.tr("未获得日历访问权限，请在系统设置 › 隐私与安全性 › 日历中允许 TodoCue。")
                                  : L10n.tr("未获得提醒事项访问权限，请在系统设置 › 隐私与安全性 › 提醒事项中允许 TodoCue。")
        }
        return nil
    }

    /// Turns a channel on (asking macOS for access when it can still ask) or off. Returns a message when it could not.
    @discardableResult
    public func setEnabled(_ kind: AppleSyncKind, _ on: Bool) async -> String? {
        guard !changing.contains(kind) else { return nil }
        changing.insert(kind)
        defer { changing.remove(kind) }
        guard on else {
            AppleSyncPreferences.setEnabled(false, for: kind, in: defaults)
            resuming.remove(kind)
            objectWillChange.send()
            return nil
        }
        if let message = await ensureAccess(kind) { return message }
        if !isEnabled(kind) { resuming.insert(kind) }
        AppleSyncPreferences.setEnabled(true, for: kind, in: defaults)
        objectWillChange.send()
        await waitUntilIdle()
        await syncNow()
        return lastError
    }

    /// Turns import from the other calendars on (asking for calendar access) or off. Turning it off
    /// keeps what was imported; the records stay so the same events are not imported twice.
    @discardableResult
    public func setImportEnabled(_ on: Bool) async -> String? {
        guard supportsImport, !importChanging else { return nil }
        importChanging = true
        defer { importChanging = false }
        guard on else {
            AppleSyncPreferences.setImportEnabled(false, in: defaults)
            refreshCalendars()
            objectWillChange.send()
            return nil
        }
        if let message = await ensureAccess(.event) { return message }
        AppleSyncPreferences.setImportEnabled(true, in: defaults)
        refreshCalendars()
        objectWillChange.send()
        await waitUntilIdle()
        await syncNow()
        return lastError
    }

    /// Leaves a calendar out of import, or takes it back. Excluding one keeps its imported tasks as they are.
    public func setCalendarIncluded(_ identifier: String, _ included: Bool) {
        var excluded = AppleSyncPreferences.excludedCalendars(in: defaults)
        excluded[identifier] = included ? nil : importCalendars.first { $0.identifier == identifier }.map(Self.calendarKey) ?? ""
        AppleSyncPreferences.setExcludedCalendars(excluded, in: defaults)
        objectWillChange.send()
        scheduleSync()
    }

    public func openPrivacySettings(_ kind: AppleSyncKind) {
        let pane = kind == .event ? "Privacy_Calendars" : "Privacy_Reminders"
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Turns the channel off and deletes TodoCue's calendar or list from Apple's side. Tasks are untouched.
    public func removeData(_ kind: AppleSyncKind) async -> String? {
        AppleSyncPreferences.setEnabled(false, for: kind, in: defaults)
        resuming.remove(kind)
        pending?.cancel()
        pending = nil
        await waitUntilIdle()
        defer { objectWillChange.send() }
        do {
            if let id = state.containerId(kind) { try store.removeContainer(kind, identifier: id) }
        } catch {
            return error.localizedDescription
        }
        state.links.removeAll { $0.kind == kind }
        state.setContainer(nil, source: nil, for: kind)
        containers[kind] = nil
        persist()
        return nil
    }

    /// Title for the container: plain for the real data, tagged for an isolated `TODOCUE_HOME` so a
    /// test runtime never adopts — and imports from — the real calendar.
    public static var containerTitle: String {
        let home = TodoCueHome.directory.standardizedFileURL
        return AppleSyncPreferences.isDefaultHome(home) ? "TodoCue" : "TodoCue (\(home.lastPathComponent))"
    }

    // MARK: - Rounds

    public func scheduleSync(after seconds: Double = 1) {
        guard isAnyEnabled else { return }
        if running { rerun = true; return }
        let now = Date()
        // Keep the first deadline once a burst has gone on long enough, so a steady stream of
        // changes cannot postpone sync indefinitely.
        if pending != nil, let first = firstRequestAt, now.timeIntervalSince(first) >= Self.maxDebounce { return }
        if pending == nil { firstRequestAt = now }
        pending?.cancel()
        pending = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.pending = nil
            self.firstRequestAt = nil
            // The round gets its own task: only the debounce sleep is ever cancelled, never a round
            // halfway through its writes (a cancelled request may still land on the runtime).
            Task { await self.syncNow() }
        }
    }

    public func syncNow() async {
        if running { rerun = true; return }
        running = true
        isSyncing = true
        var passes = 0
        repeat {
            rerun = false
            passes += 1
            await round()
        } while rerun && passes < 5
        running = false
        isSyncing = false
        if retryLater || rerun {
            // A conflict, or triggers past the pass limit: give the board time to catch up.
            retryLater = false
            rerun = false
            scheduleSync(after: 3)
        }
    }

    private func waitUntilIdle() async {
        var waited = 0
        while running && waited < 300 {
            try? await Task.sleep(nanoseconds: 100_000_000)
            waited += 1
        }
    }

    private func round() async {
        refreshAccess()
        let kinds = AppleSyncKind.allCases.filter { isEnabled($0) && store.access($0) == .granted }
        let importing = isImportEnabled && store.access(.event) == .granted
        guard !kinds.isEmpty || importing, let backend = backend(), let todo = todoTasks() else { return }
        if let reason = pauseReason() {
            lastError = reason
            return
        }
        var issues: [String] = []
        do {
            // Import first: an imported event the user moved into TodoCue's calendar becomes that
            // calendar's link here, before the mirror could take it for a new event and import it twice.
            if importing { try await importEvents(todo: todo, backend: backend, issues: &issues) }
            for kind in kinds {
                try await sync(kind, todo: todo, backend: backend, issues: &issues)
                resuming.remove(kind)
            }
            lastSyncAt = Date()
            lastError = issues.first
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func ensureContainer(_ kind: AppleSyncKind) throws -> AppleSyncContainer {
        let stored = state.containerId(kind)
        let container = try store.container(kind, identifier: stored, sourceIdentifier: state.sourceId(kind),
                                            title: Self.containerTitle)
        if container.identifier != stored {
            // A different (new or re-adopted) container: old links point nowhere. Dropping them is
            // what keeps a deleted calendar from reading as "every item deleted → delete every task".
            state.links.removeAll { $0.kind == kind }
            state.setContainer(container.identifier, source: container.sourceIdentifier, for: kind)
            persist()
        } else if container.sourceIdentifier != state.sourceId(kind) {
            // The container moved accounts under us — turning on iCloud Calendars migrates local
            // calendars into iCloud. Follow it, so a later re-creation lands in iCloud too.
            state.setContainer(container.identifier, source: container.sourceIdentifier, for: kind)
            persist()
        }
        if containers[kind] != container { containers[kind] = container }
        return container
    }

    private func sync(_ kind: AppleSyncKind, todo: [TodoTask], backend: AppleSyncBackend, issues: inout [String]) async throws {
        let container = try ensureContainer(kind)
        let links = state.links(kind)
        var items = try await store.items(kind, in: container.identifier)
        var known = Set(items.map(\.identifier))
        var departed = Set<String>()
        for link in links where !known.contains(link.identifier) {
            switch store.locate(kind, identifier: link.identifier, externalIdentifier: link.externalIdentifier,
                                in: container.identifier) {
            case .here(let item):
                if known.insert(item.identifier).inserted { items.append(item) }
            case .elsewhere:
                departed.insert(link.identifier)
            case .gone:
                break
            }
        }

        var tasks = Dictionary(todo.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for id in Set(links.map(\.taskId)) where tasks[id] == nil {
            do {
                tasks[id] = try await backend.fetchTask(id)
            } catch APIError.http(404, _, _) {
                continue // gone for good
            }
        }
        // URL references only lead to adoption; one unreadable reference must not stall the round.
        for item in items where !item.snapshot.isCompleted {
            if let id = item.snapshot.linkedTaskId, tasks[id] == nil { tasks[id] = try? await backend.fetchTask(id) }
        }

        let itemsById = Dictionary(items.map { ($0.identifier, $0) }, uniquingKeysWith: { a, _ in a })
        var actions = AppleSyncPlanner.plan(kind: kind, tasks: tasks, links: links, items: items, departed: departed,
                                            now: now())
        if kind == .event, let imports = state.imports, !imports.isEmpty {
            // An imported task's event is already in its own calendar; a TodoCue copy would show it twice.
            let imported = Set(imports.map(\.taskId))
            actions.removeAll { if case .create(let id) = $0 { return imported.contains(id) } else { return false } }
        }
        if resuming.contains(kind) {
            actions = actions.map {
                switch $0 {
                case .markMissing(let id), .deleteTask(let id): return .unlink(taskId: id)
                default: return $0
                }
            }
        }
        // Circuit breaker: many items vanishing at once is an account or sync hiccup far more often
        // than a deliberate clean-up. Deleting a task is permanent, so hold every deletion back;
        // the links stay and recover on their own.
        let isDelete: (AppleSyncAction) -> Bool = { if case .deleteTask = $0 { return true } else { return false } }
        let deletions = actions.filter(isDelete).count
        if deletions > max(3, links.count / 5) {
            actions.removeAll(where: isDelete)
            issues.append(L10n.tr("有 \(deletions) 个已同步条目同时从 Apple 侧消失，为防误删，暂未删除对应任务。如确是你删除的，请在 TodoCue 中处理这些任务。"))
        }
        // An inherited link's item may have gone while no client watched: after the same grace period
        // and breaker, it is unlinked (and re-created next round), never taken as a deletion.
        let inherited = Set(links.filter { $0.inherited == true }.map(\.taskId))
        actions = actions.map {
            if case .deleteTask(let id) = $0, inherited.contains(id) { return .unlink(taskId: id) }
            return $0
        }

        for action in actions {
            do {
                try await perform(action, kind: kind, container: container.identifier, tasks: tasks,
                                  items: itemsById, backend: backend, issues: &issues)
            } catch let error as APIError where error.isVersionConflict {
                retryLater = true // the task moved under us; a later round sees its new version
            } catch let error as APIError {
                if case .transport = error { throw error }
                issues.append(error.localizedDescription)
            } catch {
                issues.append(error.localizedDescription)
            }
            persist()
        }
        // Found this round: the item exists, so from now on a disappearance is a real one.
        var settled = false
        for link in state.links(kind) where link.inherited == true && itemsById[link.identifier] != nil {
            update(kind, link.taskId) { $0.inherited = nil }
            settled = true
        }
        if settled { persist() }
    }

    private func perform(_ action: AppleSyncAction, kind: AppleSyncKind, container: String, tasks: [String: TodoTask],
                         items: [String: AppleItem], backend: AppleSyncBackend, issues: inout [String]) async throws {
        switch action {
        case .create(let taskId):
            guard let task = tasks[taskId] else { return }
            try push(task, kind: kind, identifier: nil, container: container)
        case .push(let taskId, let identifier), .adopt(let taskId, let identifier):
            guard let task = tasks[taskId] else { return }
            try push(task, kind: kind, identifier: identifier, container: container)
        case .pull(let taskId, let identifier):
            guard let task = tasks[taskId], let item = items[identifier] else { return }
            try await pull(item, into: task, kind: kind, container: container, backend: backend, issues: &issues)
        case .deleteItem(let taskId, let identifier):
            // Forget the link first: a crash between the two steps must leave an orphan item, never a
            // link whose item is gone — that would read as a deletion and cancel the task.
            state.removeLink(kind, taskId: taskId)
            persist()
            try store.delete(kind, identifier: identifier)
        case .deleteTask(let taskId):
            if let task = tasks[taskId], task.status == .todo {
                // A task that is already gone is not an error; `delete` treats it as done.
                try await backend.delete(taskId, expectedVersion: task.version)
            }
            state.removeLink(kind, taskId: taskId)
        case .unlink(let taskId):
            state.removeLink(kind, taskId: taskId)
        case .markMissing(let taskId):
            update(kind, taskId) { $0.missingSince = TCDate.iso(now()) }
        case .detach(let taskId):
            update(kind, taskId) { $0.detachedAt = TCDate.iso(now()); $0.missingSince = nil }
        case .relink(let taskId, let identifier):
            update(kind, taskId) { link in
                link.identifier = identifier
                link.externalIdentifier = items[identifier]?.externalIdentifier ?? link.externalIdentifier
                link.missingSince = nil
                link.detachedAt = nil
            }
        case .markSynced(let taskId, let identifier):
            guard let task = tasks[taskId], let item = items[identifier] else { return }
            state.upsert(AppleSyncLink(kind: kind, taskId: taskId, identifier: identifier,
                                       externalIdentifier: item.externalIdentifier, taskVersion: task.version,
                                       lastSnapshot: item.snapshot,
                                       lastDesired: AppleSyncMapper.snapshot(for: task, kind: kind)))
        case .importItem(let identifier):
            guard let item = items[identifier] else { return }
            let payload = AppleSyncMapper.createPayload(from: item.snapshot, kind: kind)
            let created = try await backend.createTask(from: payload,
                                                       idempotencyKey: Self.importKey(kind, identifier, payload))
            // Link first, so a failed write-back below cannot import the same item twice.
            state.upsert(AppleSyncLink(kind: kind, taskId: created.id, identifier: identifier,
                                       externalIdentifier: item.externalIdentifier, taskVersion: created.version,
                                       lastSnapshot: item.snapshot))
            persist()
            try push(created, kind: kind, identifier: identifier, container: container)
        }
    }

    /// Same item, same content → same key, so a create whose response was lost is replayed by the
    /// runtime instead of creating a second task. Edited content gets a fresh key.
    static func importKey(_ kind: AppleSyncKind, _ identifier: String, _ payload: TaskPayload) -> String {
        importKey(kind.rawValue, identifier, payload)
    }

    static func importKey(_ prefix: String, _ identifier: String, _ payload: TaskPayload) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let body = (try? encoder.encode(payload.fields)) ?? Data()
        let digest = SHA256.hash(data: Data(identifier.utf8) + body)
        return "applesync-\(prefix)-" + digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    private func update(_ kind: AppleSyncKind, _ taskId: String, _ change: (inout AppleSyncLink) -> Void) {
        guard var link = state.link(kind, taskId: taskId) else { return }
        change(&link)
        state.upsert(link)
    }

    /// Writes the task's current state over the item and records both as the new baseline.
    private func push(_ task: TodoTask, kind: AppleSyncKind, identifier: String?, container: String) throws {
        guard let snapshot = AppleSyncMapper.snapshot(for: task, kind: kind) else { return }
        let saved = try store.save(kind, snapshot, timezone: task.timezone, identifier: identifier, in: container)
        state.upsert(AppleSyncLink(kind: kind, taskId: task.id, identifier: saved.identifier,
                                   externalIdentifier: saved.externalIdentifier, taskVersion: task.version,
                                   lastSnapshot: saved.snapshot, lastDesired: snapshot))
    }

    private static func isRefusal(_ error: Error) -> Bool {
        guard let api = error as? APIError, case .http(let status, _, _) = api else { return false }
        return status < 500 && !api.isVersionConflict
    }

    /// Carries the edits made in Apple's apps into the task — field by field, leaving alone whatever
    /// TodoCue changed itself since the last sync — then settles the link.
    private func pull(_ item: AppleItem, into original: TodoTask, kind: AppleSyncKind, container: String,
                      backend: AppleSyncBackend, issues: inout [String]) async throws {
        let link = state.link(kind, taskId: original.id)
        guard let desiredBefore = AppleSyncMapper.snapshot(for: original, kind: kind) else { return }
        let todoChanged = desiredBefore != link?.lastDesired
        let merged = AppleSyncMapper.merged(item: item.snapshot, baseline: link?.lastSnapshot,
                                            desired: desiredBefore, lastDesired: link?.lastDesired)
        var task = original
        var refused: [String] = []

        // Record each step as it lands, so an interrupted pull is not mistaken for TodoCue's own edit.
        func landed(_ t: TodoTask) {
            task = t
            update(kind, t.id) { $0.taskVersion = t.version }
        }
        func applyFields() async throws {
            let patch = AppleSyncMapper.patch(from: merged, task: task, kind: kind)
            guard !patch.fields.isEmpty else { return }
            do {
                landed(try await backend.updateTask(task.id, patch, expectedVersion: task.version))
            } catch where Self.isRefusal(error) {
                // The runtime rejected a value (an invalid date, an over-long title): TodoCue keeps its
                // own, and the push below puts it back on the item. The status change still goes ahead.
                refused.append(error.localizedDescription)
            }
        }

        do {
            if kind == .reminder, merged.isCompleted, task.status == .todo {
                try await applyFields()
                landed(try await backend.complete(task.id, expectedVersion: task.version))
            } else if kind == .reminder, !merged.isCompleted, task.status == .done {
                landed(try await backend.reopen(task.id, expectedVersion: task.version))
                try await applyFields()
            } else if task.status == .todo {
                try await applyFields()
            }
        } catch where Self.isRefusal(error) {
            refused.append(error.localizedDescription)
        }
        issues += refused

        let desiredNow = AppleSyncMapper.snapshot(for: task, kind: kind)
        if let desiredNow, desiredNow != item.snapshot, todoChanged || !refused.isEmpty {
            try push(task, kind: kind, identifier: item.identifier, container: container)
        } else {
            // Nothing of TodoCue's own to put back. Leave the item exactly as Apple's side has it —
            // re-pushing a normalised copy is how two writers end up ping-ponging forever.
            state.upsert(AppleSyncLink(kind: kind, taskId: task.id, identifier: item.identifier,
                                       externalIdentifier: item.externalIdentifier, taskVersion: task.version,
                                       lastSnapshot: item.snapshot, lastDesired: desiredNow ?? link?.lastDesired))
        }
    }

    // MARK: - Import from other calendars

    /// One way: new events in the included calendars become tasks, and edits made there follow, field
    /// by field, unless TodoCue changed that field itself. Nothing is ever written to those calendars.
    private func importEvents(todo: [TodoTask], backend: AppleSyncBackend, issues: inout [String]) async throws {
        refreshCalendars()
        let readable = Set(importCalendars.map(\.identifier))
        let included = readable.subtracting(excludedCalendars)
        let start = now()
        let candidates = store.events(in: included.sorted(), from: start,
                                      to: start.addingTimeInterval(AppleCalendarImportPlanner.horizon))
        let found = Dictionary(candidates.map { ($0.item.identifier, $0) }, uniquingKeysWith: { a, _ in a })
        let records = state.imports ?? []

        var tasks = Dictionary(todo.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for record in records where record.closedAt == nil && tasks[record.taskId] == nil {
            do {
                tasks[record.taskId] = try await backend.fetchTask(record.taskId)
            } catch APIError.http(404, _, _) {
                continue // deleted in TodoCue
            }
        }

        var locations: [String: AppleImportLocation] = [:]
        var moved: [(AppleCalendarImport, AppleSourceEvent)] = []
        for record in records {
            guard let event = found[record.identifier]
                    ?? store.findEvent(identifier: record.identifier, externalIdentifier: record.externalIdentifier,
                                       preferring: record.calendarId) else {
                // Gone from a calendar that is still there is a deletion; a calendar that cannot be read
                // (account signed out, calendar removed) says nothing about its events.
                locations[record.taskId] = readable.contains(record.calendarId) ? .gone : .unavailable
                continue
            }
            if record.closedAt == nil, isEnabled(.event), event.calendarId == state.calendarId, !event.isRecurring,
               tasks[record.taskId]?.status == .todo {
                moved.append((record, event))
                continue
            }
            locations[record.taskId] = included.contains(event.calendarId) && !event.isRecurring ? .here(event) : .elsewhere
        }
        // A task import cancelled comes back with its event; only then is it worth reading.
        for record in records where record.closedAt != nil && record.cancelledByImport == true && tasks[record.taskId] == nil {
            guard case .here? = locations[record.taskId] else { continue }
            tasks[record.taskId] = try? await backend.fetchTask(record.taskId)
        }

        // Moved into TodoCue's own calendar: from now on it is that task's mirrored event. The link starts
        // from import's baselines, so an edit saved together with the move (a new time) is pulled into the
        // task instead of being read as TodoCue's and overwritten. Only the `todocue://` URL reads as
        // TodoCue's own change, which is what gets it written onto the event.
        for (record, event) in moved {
            var lastDesired = record.lastDesired
            lastDesired?.url = nil
            state.removeImport(taskId: record.taskId)
            state.upsert(AppleSyncLink(kind: .event, taskId: record.taskId, identifier: event.item.identifier,
                                       externalIdentifier: event.item.externalIdentifier, taskVersion: record.taskVersion,
                                       lastSnapshot: record.lastSnapshot, lastDesired: lastDesired))
            persist()
        }

        let movedIds = Set(moved.map(\.0.taskId))
        var actions = AppleCalendarImportPlanner.plan(records: records.filter { !movedIds.contains($0.taskId) },
                                                      locations: locations, candidates: candidates, tasks: tasks, now: now())
        // Same breaker as the mirror's, overall and per calendar: many events vanishing at once is an
        // account or sync hiccup, not a clean-up — even when that calendar is a small part of the whole.
        let cancelIds = actions.compactMap { action -> String? in
            if case .cancelTask(let id) = action { return id } else { return nil }
        }
        let calendarOf = Dictionary(records.map { ($0.taskId, $0.calendarId) }, uniquingKeysWith: { a, _ in a })
        let open = records.filter { $0.closedAt == nil }
        let openIn = Dictionary(grouping: open, by: \.calendarId).mapValues(\.count)
        var held = cancelIds.count > max(3, open.count / 5) ? Set(cancelIds) : []
        for (calendar, ids) in Dictionary(grouping: cancelIds, by: { calendarOf[$0] ?? "" })
        where ids.count > max(3, (openIn[calendar] ?? 0) / 5) {
            held.formUnion(ids)
        }
        if !held.isEmpty {
            actions.removeAll { if case .cancelTask(let id) = $0 { return held.contains(id) } else { return false } }
            issues.append(L10n.tr("有 \(held.count) 个导入的日程同时从原日历消失，为防误操作，暂未取消对应任务。如确是那边删除的，请在 TodoCue 中处理这些任务。"))
        }

        for action in actions {
            do {
                try await performImport(action, tasks: tasks, backend: backend, issues: &issues)
            } catch let error as APIError where error.isVersionConflict {
                retryLater = true
            } catch let error as APIError {
                if case .transport = error { throw error }
                issues.append(error.localizedDescription)
            } catch {
                issues.append(error.localizedDescription)
            }
            persist()
        }
    }

    private func performImport(_ action: AppleImportAction, tasks: [String: TodoTask], backend: AppleSyncBackend,
                               issues: inout [String]) async throws {
        func change(_ taskId: String, _ edit: (inout AppleCalendarImport) -> Void) {
            guard var record = state.importRecord(taskId: taskId) else { return }
            edit(&record)
            state.upsertImport(record)
        }
        func follow(_ event: AppleSourceEvent) -> (inout AppleCalendarImport) -> Void {
            return { record in
                record.calendarId = event.calendarId
                record.identifier = event.item.identifier
                record.externalIdentifier = event.item.externalIdentifier ?? record.externalIdentifier
                record.missingSince = nil
            }
        }
        switch action {
        case .importEvent(let event):
            let payload = AppleSyncMapper.createPayload(from: event.item.snapshot, kind: .event)
            let created = try await backend.createTask(from: payload,
                                                       idempotencyKey: Self.importKey("import", event.item.identifier, payload))
            state.upsertImport(AppleCalendarImport(calendarId: event.calendarId, identifier: event.item.identifier,
                                                   externalIdentifier: event.item.externalIdentifier, taskId: created.id,
                                                   taskVersion: created.version, lastSnapshot: event.item.snapshot,
                                                   lastDesired: AppleCalendarImportPlanner.desired(for: created)))
        case .pull(let taskId, let event):
            guard let record = state.importRecord(taskId: taskId), let task = tasks[taskId] else { return }
            let desired = AppleCalendarImportPlanner.desired(for: task)
            let merged = AppleSyncMapper.merged(item: event.item.snapshot, baseline: record.lastSnapshot,
                                                desired: desired, lastDesired: record.lastDesired)
            let patch = AppleSyncMapper.patch(from: merged, task: task, kind: .event)
            var updated = task
            if !patch.fields.isEmpty {
                do {
                    updated = try await backend.updateTask(taskId, patch, expectedVersion: task.version)
                } catch where Self.isRefusal(error) {
                    // The runtime rejected a value: the task keeps its own, and this edit is not retried.
                    issues.append(error.localizedDescription)
                }
            }
            change(taskId) { record in
                follow(event)(&record)
                record.taskVersion = updated.version
                record.lastSnapshot = event.item.snapshot
                record.lastDesired = AppleCalendarImportPlanner.baseline(after: AppleCalendarImportPlanner.desired(for: updated),
                                                                         desiredBefore: desired, lastDesired: record.lastDesired)
            }
        case .settle(let taskId, let event):
            change(taskId, follow(event))
        case .markMissing(let taskId):
            change(taskId) { $0.missingSince = TCDate.iso(now()) }
        case .cancelTask(let taskId):
            if let task = tasks[taskId], task.status == .todo {
                do {
                    _ = try await backend.cancel(taskId, expectedVersion: task.version)
                } catch APIError.http(404, _, _) {
                    // Deleted in TodoCue meanwhile: nothing left to cancel.
                }
            }
            change(taskId) { $0.closedAt = TCDate.iso(now()); $0.missingSince = nil; $0.cancelledByImport = true }
        case .close(let taskId):
            change(taskId) { $0.closedAt = TCDate.iso(now()); $0.missingSince = nil }
        case .resume(let taskId, let event):
            change(taskId) { follow(event)(&$0); $0.closedAt = nil; $0.cancelledByImport = nil }
        case .restoreTask(let taskId, let event):
            guard let task = tasks[taskId], task.status == .cancelled else { return }
            let reopened = try await backend.reopen(taskId, expectedVersion: task.version)
            change(taskId) {
                follow(event)(&$0)
                $0.closedAt = nil
                $0.cancelledByImport = nil
                $0.taskVersion = reopened.version
            }
        case .forget(let taskId):
            state.removeImport(taskId: taskId)
        }
    }

    private func persist() {
        do { try state.save(to: stateURL) }
        catch { lastError = error.localizedDescription }
    }

    // Test hooks.
    var links: [AppleSyncLink] { state.links }
    var imports: [AppleCalendarImport] { state.imports ?? [] }
}
