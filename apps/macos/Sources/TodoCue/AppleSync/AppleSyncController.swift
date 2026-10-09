import AppKit
import Combine
import CryptoKit
import TodoCueKit

/// The slice of the runtime API that sync writes through.
protocol AppleSyncBackend: Sendable {
    func fetchTask(_ id: String) async throws -> TodoTask
    func createTask(from payload: TaskPayload, idempotencyKey: String) async throws -> TodoTask
    func updateTask(_ id: String, _ payload: TaskPayload, expectedVersion: Int?) async throws -> TodoTask
    func complete(_ id: String, expectedVersion: Int?) async throws -> TodoTask
    func reopen(_ id: String, expectedVersion: Int?) async throws -> TodoTask
    func cancel(_ id: String, expectedVersion: Int?) async throws -> TodoTask
}

extension APIClient: AppleSyncBackend {
    func fetchTask(_ id: String) async throws -> TodoTask { try await task(id).task }
    func createTask(from payload: TaskPayload, idempotencyKey: String) async throws -> TodoTask {
        try await createTask(payload, idempotencyKey: idempotencyKey).task
    }
}

/// Two-way mirror of TodoCue tasks into a dedicated Apple calendar and reminder list.
///
/// TodoCue stays the source of truth: a round reads both sides, `AppleSyncPlanner` decides, and
/// this class carries the plan out. Rounds are serialised; triggers that arrive mid-round re-run it.
@MainActor
final class AppleSyncController: ObservableObject {
    @Published private(set) var access: [AppleSyncKind: AppleSyncAccess] = [:]
    @Published private(set) var containers: [AppleSyncKind: AppleSyncContainer] = [:]
    @Published private(set) var lastSyncAt: Date?
    @Published private(set) var lastError: String?
    @Published private(set) var isSyncing = false
    /// Channels whose switch is being flipped (permission prompt, first round) — the UI holds them still.
    @Published private(set) var changing: Set<AppleSyncKind> = []

    /// A burst of triggers is coalesced, but never for longer than this.
    static let maxDebounce: TimeInterval = 5

    private let store: AppleItemStore
    private let stateURL: URL
    private let defaults: UserDefaults
    private var state: AppleSyncState
    var backend: () -> AppleSyncBackend?
    /// The todo tasks of a loaded board, or nil while none has arrived (nothing must be judged missing then).
    var todoTasks: () -> [TodoTask]?
    var now: () -> Date = Date.init
    private var pending: Task<Void, Never>?
    private var firstRequestAt: Date?
    private var running = false
    private var rerun = false
    private var retryLater = false
    /// Channels just switched (back) on: their first round treats missing items as stale links,
    /// never as deletions — the user may have tidied Apple's side while sync was off.
    private var resuming: Set<AppleSyncKind> = []
    private var cancellables: Set<AnyCancellable> = []

    init(store: AppleItemStore, stateURL: URL = AppleSyncState.defaultURL, defaults: UserDefaults = .standard,
         backend: @escaping () -> AppleSyncBackend? = { nil }, todoTasks: @escaping () -> [TodoTask]? = { nil }) {
        self.store = store
        self.stateURL = stateURL
        self.defaults = defaults
        self.backend = backend
        self.todoTasks = todoTasks
        self.state = AppleSyncState.load(from: stateURL)
        store.onChange = { [weak self] in self?.scheduleSync() }
        refreshAccess()
    }

    /// Wire to the app model: board changes, reconnects and a slow heartbeat all trigger a round.
    func attach(to model: AppModel) {
        backend = { [weak model] in model?.canWrite == true ? model?.client : nil }
        todoTasks = { [weak model] in
            guard let model, model.connectionState.isOnline, model.context != nil else { return nil }
            return model.allTasks
        }
        model.$allTasks.dropFirst().sink { [weak self] _ in self?.scheduleSync() }.store(in: &cancellables)
        model.$connectionState.removeDuplicates().filter(\.isOnline).sink { [weak self] _ in self?.scheduleSync() }
            .store(in: &cancellables)
        Timer.publish(every: 300, on: .main, in: .common).autoconnect()
            .sink { [weak self] _ in self?.scheduleSync() }.store(in: &cancellables)
        NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)
            .sink { [weak self] _ in self?.refreshAccess() }.store(in: &cancellables)
        scheduleSync()
    }

    // MARK: - Settings

    func isEnabled(_ kind: AppleSyncKind) -> Bool { Prefs.isAppleSyncEnabled(kind, in: defaults) }

    var isAnyEnabled: Bool { AppleSyncKind.allCases.contains(where: isEnabled) }

    func refreshAccess() {
        let current = Dictionary(uniqueKeysWithValues: AppleSyncKind.allCases.map { ($0, store.access($0)) })
        if current != access { access = current }
    }

    /// Turns a channel on (asking macOS for access when it can still ask) or off. Returns a message when it could not.
    @discardableResult
    func setEnabled(_ kind: AppleSyncKind, _ on: Bool) async -> String? {
        guard !changing.contains(kind) else { return nil }
        changing.insert(kind)
        defer { changing.remove(kind) }
        guard on else {
            Prefs.setAppleSyncEnabled(false, for: kind, in: defaults)
            resuming.remove(kind)
            objectWillChange.send()
            return nil
        }
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
        if !isEnabled(kind) { resuming.insert(kind) }
        Prefs.setAppleSyncEnabled(true, for: kind, in: defaults)
        objectWillChange.send()
        await waitUntilIdle()
        await syncNow()
        return lastError
    }

    func openPrivacySettings(_ kind: AppleSyncKind) {
        let pane = kind == .event ? "Privacy_Calendars" : "Privacy_Reminders"
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Turns the channel off and deletes TodoCue's calendar or list from Apple's side. Tasks are untouched.
    func removeData(_ kind: AppleSyncKind) async -> String? {
        Prefs.setAppleSyncEnabled(false, for: kind, in: defaults)
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
    static var containerTitle: String {
        let home = TodoCueHome.directory.standardizedFileURL
        let real = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".todocue").standardizedFileURL
        return home.path == real.path ? "TodoCue" : "TodoCue (\(home.lastPathComponent))"
    }

    // MARK: - Rounds

    func scheduleSync(after seconds: Double = 1) {
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

    func syncNow() async {
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
        guard !kinds.isEmpty, let backend = backend(), let todo = todoTasks() else { return }
        var issues: [String] = []
        do {
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
            // what keeps a deleted calendar from reading as "every item deleted → cancel everything".
            state.links.removeAll { $0.kind == kind }
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
        if resuming.contains(kind) {
            actions = actions.map {
                switch $0 {
                case .markMissing(let id), .cancelTask(let id): return .unlink(taskId: id)
                default: return $0
                }
            }
        }
        // Circuit breaker: many items vanishing at once is an account or sync hiccup far more often
        // than a deliberate clean-up. Hold the cancellations; the links stay and recover on their own.
        let isCancel: (AppleSyncAction) -> Bool = { if case .cancelTask = $0 { return true } else { return false } }
        let cancels = actions.filter(isCancel).count
        if cancels > max(3, links.count / 5) {
            actions.removeAll(where: isCancel)
            issues.append(L10n.tr("有 \(cancels) 个已同步条目同时从 Apple 侧消失，为防误删，暂未取消对应任务。如确是你删除的，请在 TodoCue 中处理这些任务。"))
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
        case .cancelTask(let taskId):
            if let task = tasks[taskId], task.status == .todo {
                _ = try await backend.cancel(taskId, expectedVersion: task.version)
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
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let body = (try? encoder.encode(payload.fields)) ?? Data()
        let digest = SHA256.hash(data: Data(identifier.utf8) + body)
        return "applesync-\(kind.rawValue)-" + digest.prefix(16).map { String(format: "%02x", $0) }.joined()
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

    private func persist() {
        do { try state.save(to: stateURL) }
        catch { lastError = error.localizedDescription }
    }

    // Test hook.
    var links: [AppleSyncLink] { state.links }
}
