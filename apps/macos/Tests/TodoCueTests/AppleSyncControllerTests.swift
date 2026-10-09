import XCTest
import TodoCueKit
@testable import TodoCue

@MainActor
private final class FakeItemStore: AppleItemStore {
    struct Stored: Equatable { var snapshot: AppleItemSnapshot; var external: String }

    var onChange: (() -> Void)?
    var granted = true
    var sourceAvailable = true
    /// The account the containers currently live in (macOS can migrate a calendar between accounts).
    var source = "local"
    var containers: [AppleSyncKind: String] = [:]
    var items: [AppleSyncKind: [String: Stored]] = [.event: [:], .reminder: [:]]
    /// Linked items that still exist but were moved to another calendar or made recurring.
    var elsewhere: Set<String> = []
    /// What the account does to an item on save (Reminders dropping the URL, trimming, …).
    var normalize: (AppleSyncKind, AppleItemSnapshot) -> AppleItemSnapshot = { $1 }
    private(set) var saves = 0
    private var next = 0

    func access(_ kind: AppleSyncKind) -> AppleSyncAccess { granted ? .granted : .denied }
    func requestAccess(_ kind: AppleSyncKind) async -> Bool { granted }

    func container(_ kind: AppleSyncKind, identifier: String?, sourceIdentifier: String?, title: String) throws -> AppleSyncContainer {
        if let identifier, containers[kind] == identifier {
            return AppleSyncContainer(identifier: identifier, title: title, sourceTitle: source, sourceIdentifier: source,
                                      isICloud: source == "icloud")
        }
        if sourceIdentifier != nil && !sourceAvailable { throw AppleSyncStoreError.accountUnavailable }
        next += 1
        let id = "\(kind)-container-\(next)"
        containers[kind] = id
        items[kind] = [:]
        return AppleSyncContainer(identifier: id, title: title, sourceTitle: source, sourceIdentifier: source,
                                  isICloud: source == "icloud")
    }

    private func item(_ id: String, _ stored: Stored) -> AppleItem {
        AppleItem(identifier: id, externalIdentifier: stored.external, snapshot: stored.snapshot)
    }

    func items(_ kind: AppleSyncKind, in container: String) async throws -> [AppleItem] {
        (items[kind] ?? [:]).map { item($0.key, $0.value) }.sorted { $0.identifier < $1.identifier }
    }

    func locate(_ kind: AppleSyncKind, identifier: String, externalIdentifier: String?, in container: String) -> AppleItemLocation {
        if let stored = items[kind]?[identifier] { return .here(item(identifier, stored)) }
        if elsewhere.contains(identifier) { return .elsewhere }
        if let externalIdentifier, let match = items[kind]?.first(where: { $0.value.external == externalIdentifier }) {
            return .here(item(match.key, match.value))
        }
        return .gone
    }

    func save(_ kind: AppleSyncKind, _ snapshot: AppleItemSnapshot, timezone: String, identifier: String?,
              in container: String) throws -> AppleItem {
        saves += 1
        let id = identifier ?? { next += 1; return "\(kind)-item-\(next)" }()
        let stored = Stored(snapshot: normalize(kind, snapshot), external: items[kind]?[id]?.external ?? "ext-\(id)")
        items[kind, default: [:]][id] = stored
        return item(id, stored)
    }

    func delete(_ kind: AppleSyncKind, identifier: String) throws { items[kind]?[identifier] = nil }

    func removeContainer(_ kind: AppleSyncKind, identifier: String) throws {
        containers[kind] = nil
        items[kind] = [:]
    }

    /// Simulates an edit made on the phone.
    func edit(_ kind: AppleSyncKind, _ id: String, _ change: (inout AppleItemSnapshot) -> Void) {
        guard var s = items[kind]?[id] else { return }
        change(&s.snapshot)
        items[kind]?[id] = s
    }

    func only(_ kind: AppleSyncKind) -> String { items[kind]!.keys.sorted().first! }
}

private final class FakeBackend: AppleSyncBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var store: [String: TodoTask] = [:]
    private var byKey: [String: String] = [:]
    private(set) var calls: [String] = []
    /// Called on every write, from inside the request — the moment SSE would announce it.
    var onWrite: (@Sendable () async -> Void)?
    /// Next create stores the task but "loses" the response, like a runtime restart mid-request.
    var loseNextCreateResponse = false

    init(_ tasks: [TodoTask]) { for t in tasks { store[t.id] = t } }

    var todo: [TodoTask] { lock.withLock { store.values.filter { $0.status == .todo }.sorted { $0.id < $1.id } } }
    var all: [TodoTask] { lock.withLock { Array(store.values) } }
    subscript(id: String) -> TodoTask? { lock.withLock { store[id] } }

    func touch(_ id: String, _ change: (inout TodoTask) -> Void) {
        lock.withLock {
            guard var t = store[id] else { return }
            change(&t); t.version += 1; store[id] = t
        }
    }

    private func mutate(_ id: String, _ call: String, expectedVersion: Int?, _ change: (inout TodoTask) -> Void) async throws -> TodoTask {
        await onWrite?()
        // URLSession fails a cancelled task's request; mirror that so cancelled rounds show up.
        if Task.isCancelled { throw APIError.transport("cancelled") }
        return try lock.withLock {
            calls.append("\(call) \(id)")
            guard var t = store[id] else { throw APIError.http(status: 404, code: "NOT_FOUND", message: "") }
            if let v = expectedVersion, v != t.version {
                throw APIError.http(status: 409, code: "VERSION_CONFLICT", message: "")
            }
            change(&t); t.version += 1; store[id] = t
            return t
        }
    }

    func fetchTask(_ id: String) async throws -> TodoTask {
        guard let t = self[id] else { throw APIError.http(status: 404, code: "NOT_FOUND", message: "") }
        return t
    }

    func createTask(from payload: TaskPayload, idempotencyKey: String) async throws -> TodoTask {
        let (task, lose): (TodoTask, Bool) = lock.withLock {
            if let existing = byKey[idempotencyKey], let t = store[existing] { return (t, false) }
            var t = AppleSyncControllerTests.task("new\(store.count)")
            t.title = ""
            Self.apply(payload, to: &t)
            calls.append("create \(t.title)")
            store[t.id] = t
            byKey[idempotencyKey] = t.id
            defer { loseNextCreateResponse = false }
            return (t, loseNextCreateResponse)
        }
        if lose { throw APIError.transport("connection reset") }
        return task
    }

    func updateTask(_ id: String, _ payload: TaskPayload, expectedVersion: Int?) async throws -> TodoTask {
        try await mutate(id, "update", expectedVersion: expectedVersion) { Self.apply(payload, to: &$0) }
    }
    func complete(_ id: String, expectedVersion: Int?) async throws -> TodoTask {
        try await mutate(id, "complete", expectedVersion: expectedVersion) { $0.status = .done; $0.completedAt = "2026-10-09T00:00:00Z" }
    }
    func reopen(_ id: String, expectedVersion: Int?) async throws -> TodoTask {
        try await mutate(id, "reopen", expectedVersion: expectedVersion) { $0.status = .todo; $0.completedAt = nil }
    }
    func cancel(_ id: String, expectedVersion: Int?) async throws -> TodoTask {
        try await mutate(id, "cancel", expectedVersion: expectedVersion) { $0.status = .cancelled }
    }

    private static func apply(_ payload: TaskPayload, to t: inout TodoTask) {
        func string(_ key: String) -> String?? {
            switch payload.fields[key] {
            case .string(let s)?: return .some(s)
            case .null?: return .some(nil)
            default: return nil
            }
        }
        if let v = string("title") { t.title = v ?? "" }
        if let v = string("notes") { t.notes = v }
        if let v = string("scheduledDate") { t.scheduledDate = v }
        if let v = string("scheduledAt") { t.scheduledAt = v }
        if let v = string("dueDate") { t.dueDate = v }
        if let v = string("dueAt") { t.dueAt = v }
        if let v = string("priority"), let p = v.flatMap(Priority.init(rawValue:)) { t.priority = p }
        if case .int(let m)? = payload.fields["estimateMinutes"] { t.estimateMinutes = m }
    }
}

@MainActor
final class AppleSyncControllerTests: XCTestCase {
    nonisolated static func task(_ id: String, scheduledDate: String? = nil, dueDate: String? = nil) -> TodoTask {
        TodoTask(id: id, title: "任务 \(id)", scheduledDate: scheduledDate, dueDate: dueDate, timezone: "Asia/Shanghai",
                 createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z")
    }

    private var dir: URL!
    private var defaults: UserDefaults!
    private var suite: String!
    private var clock = Date(timeIntervalSince1970: 1_791_000_000)

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("todocue-applesync-" + UUID().uuidString)
        suite = "todocue-applesync-" + UUID().uuidString
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    private func make(_ store: FakeItemStore, _ backend: FakeBackend, kinds: [AppleSyncKind] = [.event]) -> AppleSyncController {
        for kind in kinds { Prefs.setAppleSyncEnabled(true, for: kind, in: defaults) }
        let sync = AppleSyncController(store: store, stateURL: dir.appendingPathComponent("apple-sync.json"), defaults: defaults,
                                       backend: { backend }, todoTasks: { backend.todo })
        sync.now = { [unowned self] in self.clock }
        return sync
    }

    private func advance(minutes: Double) { clock = clock.addingTimeInterval(minutes * 60) }

    // MARK: - Basics

    func testDatedTasksAreMirroredAndPersisted() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", scheduledDate: "2026-10-09"), Self.task("b")])
        let sync = make(store, backend)
        await sync.syncNow()

        let items = store.items[.event]!
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items.values.first?.snapshot.url, "todocue://task/a")
        XCTAssertNil(sync.lastError)
        let saved = AppleSyncState.load(from: dir.appendingPathComponent("apple-sync.json"))
        XCTAssertEqual(saved.links.map(\.taskId), ["a"])

        // A second round with nothing changed writes nothing anywhere.
        await sync.syncNow()
        XCTAssertEqual(backend.calls, [])
        XCTAssertEqual(store.items[.event], items)
        XCTAssertEqual(store.saves, 1)
    }

    func testPhoneEditsFlowBack() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", scheduledDate: "2026-10-09")])
        let sync = make(store, backend)
        await sync.syncNow()
        let id = store.only(.event)

        store.edit(.event, id) { $0.start = .day("2026-10-11"); $0.end = .day("2026-10-11"); $0.title = "改期" }
        await sync.syncNow()
        XCTAssertEqual(backend["a"]?.scheduledDate, "2026-10-11")
        XCTAssertEqual(backend["a"]?.title, "改期")
        XCTAssertEqual(backend.calls, ["update a"])

        // The follow-up round (SSE echo) must be quiet.
        await sync.syncNow()
        XCTAssertEqual(backend.calls, ["update a"])
    }

    func testTodoCueEditsArePushed() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", scheduledDate: "2026-10-09")])
        let sync = make(store, backend)
        await sync.syncNow()
        backend.touch("a") { $0.title = "在 Mac 上改的" }
        await sync.syncNow()
        XCTAssertEqual(store.items[.event]!.values.first?.snapshot.title, "在 Mac 上改的")
        XCTAssertEqual(backend.calls, [])
    }

    func testReminderCheckboxCompletesAndReopens() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", dueDate: "2026-10-12")])
        let sync = make(store, backend, kinds: [.reminder])
        await sync.syncNow()
        let id = store.only(.reminder)

        store.edit(.reminder, id) { $0.isCompleted = true }
        await sync.syncNow()
        XCTAssertEqual(backend["a"]?.status, .done)

        store.edit(.reminder, id) { $0.isCompleted = false }
        await sync.syncNow()
        XCTAssertEqual(backend["a"]?.status, .todo)
        XCTAssertEqual(backend.calls, ["complete a", "reopen a"])
    }

    func testItemsAddedOnThePhoneBecomeTasks() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([])
        let sync = make(store, backend)
        await sync.syncNow()
        _ = try store.save(.event, AppleItemSnapshot(title: "看牙", start: .day("2026-10-10"), end: .day("2026-10-10")),
                           timezone: "Asia/Shanghai", identifier: "phone", in: store.containers[.event]!)
        await sync.syncNow()

        XCTAssertEqual(backend.calls, ["create 看牙"])
        let created = backend.todo.first
        XCTAssertEqual(created?.scheduledDate, "2026-10-10")
        XCTAssertEqual(store.items[.event]!["phone"]?.snapshot.url, created.map { AppleSyncMapper.url(for: $0.id) })
        await sync.syncNow()
        XCTAssertEqual(backend.calls, ["create 看牙"])
    }

    // MARK: - Deletions are believed only when they are deletions

    func testDeletionCancelsOnlyAfterTheGracePeriod() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", scheduledDate: "2026-10-09")])
        let sync = make(store, backend)
        await sync.syncNow()
        store.items[.event] = [:]

        await sync.syncNow()
        XCTAssertEqual(backend["a"]?.status, .todo)
        XCTAssertNotNil(sync.links.first?.missingSince)

        advance(minutes: 11)
        await sync.syncNow()
        XCTAssertEqual(backend["a"]?.status, .cancelled)
        XCTAssertTrue(sync.links.isEmpty)
    }

    func testItemBackUnderANewIdentifierIsRelinkedNotCancelled() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", dueDate: "2026-10-12")])
        // Reminders may not keep our URL; the server id is what finds it again.
        store.normalize = { _, s in var s = s; s.url = nil; return s }
        let sync = make(store, backend, kinds: [.reminder])
        await sync.syncNow()
        let old = store.only(.reminder)
        let stored = store.items[.reminder]![old]!
        store.items[.reminder] = [:]
        await sync.syncNow() // missing for now

        store.items[.reminder] = ["resynced": stored]
        advance(minutes: 30)
        await sync.syncNow()
        XCTAssertEqual(backend["a"]?.status, .todo)
        XCTAssertEqual(sync.links.first?.identifier, "resynced")
        XCTAssertNil(sync.links.first?.missingSince)
        XCTAssertEqual(backend.calls, [])
    }

    func testMovedOrRecurringItemDetachesInsteadOfCancelling() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", scheduledDate: "2026-10-09")])
        let sync = make(store, backend)
        await sync.syncNow()
        let id = store.only(.event)
        store.items[.event] = [:]
        store.elsewhere = [id]

        await sync.syncNow()
        advance(minutes: 60)
        await sync.syncNow()
        XCTAssertEqual(backend["a"]?.status, .todo)
        XCTAssertNotNil(sync.links.first?.detachedAt)
        XCTAssertTrue(store.items[.event]!.isEmpty, "a detached task must not be re-created as a twin")
    }

    func testManyItemsVanishingAtOnceAreNotCancelled() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend((1...6).map { Self.task("t\($0)", scheduledDate: "2026-10-09") })
        let sync = make(store, backend)
        await sync.syncNow()
        store.items[.event] = [:]

        await sync.syncNow()
        advance(minutes: 20)
        await sync.syncNow()
        XCTAssertEqual(backend.todo.count, 6)
        XCTAssertEqual(sync.links.count, 6)
        XCTAssertNotNil(sync.lastError)
    }

    func testReenablingAfterTidyingUpDoesNotCancel() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", scheduledDate: "2026-10-09")])
        let sync = make(store, backend)
        await sync.syncNow()
        await sync.setEnabled(.event, false)
        store.items[.event] = [:] // cleaned up on the phone while sync was off

        await sync.setEnabled(.event, true)
        advance(minutes: 30)
        await sync.syncNow()
        XCTAssertEqual(backend["a"]?.status, .todo)
        XCTAssertEqual(store.items[.event]!.count, 1, "the task is mirrored again")
    }

    func testDeletedContainerIsRecreatedWithoutCancellingTasks() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", scheduledDate: "2026-10-09")])
        let sync = make(store, backend)
        await sync.syncNow()
        store.containers[.event] = nil
        store.items[.event] = [:]

        await sync.syncNow()
        XCTAssertEqual(backend.calls, [])
        XCTAssertEqual(backend["a"]?.status, .todo)
        XCTAssertEqual(store.items[.event]!.count, 1)
    }

    func testUnavailableAccountPausesInsteadOfMoving() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", scheduledDate: "2026-10-09")])
        let sync = make(store, backend)
        await sync.syncNow()
        store.containers[.event] = nil
        store.sourceAvailable = false

        await sync.syncNow()
        XCTAssertEqual(sync.lastError, AppleSyncStoreError.accountUnavailable.errorDescription)
        XCTAssertNil(store.containers[.event])
        XCTAssertEqual(sync.links.count, 1)
    }

    func testContainerMigratedToICloudIsFollowed() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", scheduledDate: "2026-10-09")])
        let sync = make(store, backend)
        await sync.syncNow()
        XCTAssertEqual(sync.containers[.event]?.isICloud, false)

        store.source = "icloud" // the user turned on iCloud Calendars; macOS moved the calendar
        await sync.syncNow()
        XCTAssertEqual(sync.containers[.event]?.isICloud, true)
        let saved = AppleSyncState.load(from: dir.appendingPathComponent("apple-sync.json"))
        XCTAssertEqual(saved.sourceId(.event), "icloud")
        XCTAssertEqual(sync.links.count, 1, "same calendar: links are kept")
        XCTAssertEqual(backend.calls, [])
    }

    // MARK: - Merging

    func testPhoneCompletionSurvivesAnUnrelatedTodoCueEdit() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", dueDate: "2026-10-12")])
        let sync = make(store, backend, kinds: [.reminder])
        await sync.syncNow()
        store.edit(.reminder, store.only(.reminder)) { $0.isCompleted = true }
        backend.touch("a") { $0.project = "工作" } // version moves, nothing the reminder shows

        await sync.syncNow()
        XCTAssertEqual(backend["a"]?.status, .done)
        XCTAssertEqual(store.items[.reminder]!.values.first?.snapshot.isCompleted, true)
    }

    func testBothSidesEditingDifferentFieldsKeepsBoth() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", dueDate: "2026-10-12")])
        let sync = make(store, backend, kinds: [.reminder])
        await sync.syncNow()
        store.edit(.reminder, store.only(.reminder)) { $0.title = "手机上改的标题" }
        backend.touch("a") { $0.dueDate = "2026-10-20" }

        await sync.syncNow()
        XCTAssertEqual(backend["a"]?.title, "手机上改的标题")
        XCTAssertEqual(backend["a"]?.dueDate, "2026-10-20")
        let item = store.items[.reminder]!.values.first!.snapshot
        XCTAssertEqual(item.title, "手机上改的标题")
        XCTAssertEqual(item.due, .day("2026-10-20"))
    }

    func testSameFieldEditedOnBothSidesTodoCueWins() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", dueDate: "2026-10-12")])
        let sync = make(store, backend, kinds: [.reminder])
        await sync.syncNow()
        store.edit(.reminder, store.only(.reminder)) { $0.title = "手机" }
        backend.touch("a") { $0.title = "Mac" }

        await sync.syncNow()
        XCTAssertEqual(backend["a"]?.title, "Mac")
        XCTAssertEqual(store.items[.reminder]!.values.first?.snapshot.title, "Mac")
    }

    func testAccountNormalisationDoesNotPingPong() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", dueDate: "2026-10-12")])
        store.normalize = { _, s in var s = s; s.url = nil; s.priority = s.priority == 9 ? 6 : s.priority; return s }
        let sync = make(store, backend, kinds: [.reminder])
        await sync.syncNow()
        store.edit(.reminder, store.only(.reminder)) { $0.title = "改过" }
        await sync.syncNow()
        let saves = store.saves
        for _ in 0..<3 { await sync.syncNow() }
        XCTAssertEqual(store.saves, saves)
        XCTAssertEqual(backend.calls, ["update a"])
    }

    func testMultiDayEventEditedOnThePhoneIsNotFlattened() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", scheduledDate: "2026-10-09")])
        let sync = make(store, backend)
        await sync.syncNow()
        let id = store.only(.event)
        store.edit(.event, id) { $0.end = .day("2026-10-11") }

        await sync.syncNow()
        await sync.syncNow()
        XCTAssertEqual(store.items[.event]![id]?.snapshot.end, .day("2026-10-11"))
    }

    // MARK: - Robustness

    func testLostCreateResponseDoesNotDuplicateTheImport() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([])
        let sync = make(store, backend)
        await sync.syncNow()
        _ = try store.save(.event, AppleItemSnapshot(title: "看牙", start: .day("2026-10-10"), end: .day("2026-10-10")),
                           timezone: "Asia/Shanghai", identifier: "phone", in: store.containers[.event]!)
        backend.loseNextCreateResponse = true
        await sync.syncNow()
        XCTAssertNotNil(sync.lastError)

        await sync.syncNow()
        XCTAssertEqual(backend.all.count, 1)
        XCTAssertEqual(sync.links.count, 1)
    }

    func testTriggersDuringARoundDoNotCancelIt() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend(["a", "b", "c"].map { Self.task($0, scheduledDate: "2026-10-09") })
        let sync = make(store, backend)
        await sync.syncNow()
        for id in store.items[.event]!.keys { store.edit(.event, id) { $0.title += "!" } }
        // Every write announces itself mid-round, like SSE and EKEventStoreChanged do.
        backend.onWrite = { await MainActor.run { sync.scheduleSync(after: 0) } }

        sync.scheduleSync(after: 0)
        for _ in 0..<200 where backend.calls.count < 3 || sync.isSyncing {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(backend.calls.sorted(), ["update a", "update b", "update c"])
        XCTAssertNil(sync.lastError)
        XCTAssertTrue(backend.todo.allSatisfy { $0.title.hasSuffix("!") })
    }

    func testNothingRunsWithoutABoardOrAccess() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", scheduledDate: "2026-10-09")])
        let sync = make(store, backend)
        sync.todoTasks = { nil }
        await sync.syncNow()
        XCTAssertTrue(store.items[.event]!.isEmpty)

        sync.todoTasks = { backend.todo }
        store.granted = false
        await sync.syncNow()
        XCTAssertTrue(store.items[.event]!.isEmpty)
    }

    func testRemoveDataDropsContainerAndTurnsOff() async throws {
        let store = FakeItemStore()
        let backend = FakeBackend([Self.task("a", scheduledDate: "2026-10-09")])
        let sync = make(store, backend)
        await sync.syncNow()
        let message = await sync.removeData(.event)
        XCTAssertNil(message)
        XCTAssertNil(store.containers[.event])
        XCTAssertFalse(sync.isEnabled(.event))
        XCTAssertTrue(sync.links.isEmpty)
        XCTAssertEqual(backend["a"]?.status, .todo)
    }

    func testImportKeyIsStableForSameContentOnly() {
        var p = TaskPayload()
        p.set("title", "看牙")
        let a = AppleSyncController.importKey(.event, "x", p)
        XCTAssertEqual(a, AppleSyncController.importKey(.event, "x", p))
        p.set("title", "看牙医")
        XCTAssertNotEqual(a, AppleSyncController.importKey(.event, "x", p))
    }
}
