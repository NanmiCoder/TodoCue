import XCTest
import TodoCueKit
@testable import AppleSyncKit

/// Import of new events from the user's other calendars (one way, read only).
@MainActor
final class CalendarImportTests: XCTestCase {
    private var dir: URL!
    private var defaults: UserDefaults!
    private var suite: String!
    /// 2026-10-03T04:00:00Z
    private var clock = Date(timeIntervalSince1970: 1_791_000_000)
    private let boss = AppleCalendarInfo(identifier: "boss", title: "BOSS直聘日历", sourceTitle: "iCloud")

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("todocue-import-" + UUID().uuidString)
        suite = "todocue-import-" + UUID().uuidString
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    private func make(_ store: FakeItemStore, _ backend: FakeBackend, mirror: [AppleSyncKind] = [],
                      supportsImport: Bool = true) -> AppleSyncController {
        for kind in mirror { AppleSyncPreferences.setEnabled(true, for: kind, in: defaults) }
        AppleSyncPreferences.setImportEnabled(true, in: defaults)
        let sync = AppleSyncController(store: store, stateURL: dir.appendingPathComponent("apple-sync.json"), defaults: defaults,
                                       client: "desktop", backend: { backend }, todoTasks: { backend.todo })
        sync.supportsImport = supportsImport
        sync.now = { [unowned self] in self.clock }
        return sync
    }

    private func advance(minutes: Double) { clock = clock.addingTimeInterval(minutes * 60) }

    private func at(_ iso: String) -> AppleDateValue { AppleDateValue.at(iso)! }

    /// A 30-minute event.
    @discardableResult
    private func add(_ store: FakeItemStore, _ id: String, title: String, start: String = "2026-10-09T08:00:00Z",
                     calendar: String = "boss", url: String? = nil, recurring: Bool = false) -> AppleSourceEvent {
        let begin = TCDate.parse(start)!
        let snapshot = AppleItemSnapshot(title: title, start: .at(begin), end: .at(begin.addingTimeInterval(30 * 60)), url: url)
        let event = AppleSourceEvent(calendarId: calendar, item: AppleItem(identifier: id, externalIdentifier: "ext-\(id)", snapshot: snapshot),
                                     isRecurring: recurring)
        store.sourceEvents[id] = event
        return event
    }

    private func edit(_ store: FakeItemStore, _ id: String, _ change: (inout AppleItemSnapshot) -> Void) {
        change(&store.sourceEvents[id]!.item.snapshot)
    }

    // MARK: -

    func testNewEventsInOtherCalendarsBecomeTasksAndAreNotMirroredBack() async throws {
        let store = FakeItemStore()
        store.calendars = [boss]
        add(store, "e1", title: "视频面试")
        let backend = FakeBackend([])
        let sync = make(store, backend, mirror: [.event])
        await sync.syncNow()

        XCTAssertEqual(backend.calls, ["create 视频面试"])
        let task = try XCTUnwrap(backend.todo.first)
        XCTAssertEqual(task.scheduledAt.flatMap(AppleDateValue.at), at("2026-10-09T08:00:00Z"))
        XCTAssertEqual(task.estimateMinutes, 30)
        XCTAssertEqual(sync.imports.map(\.taskId), [task.id])
        XCTAssertEqual(sync.importCalendars, [boss], "TodoCue's own calendar is not offered for import")

        // The board now carries the task; the mirror must not copy it into the TodoCue calendar.
        await sync.syncNow()
        await sync.syncNow()
        XCTAssertEqual(backend.calls, ["create 视频面试"])
        XCTAssertTrue(store.items[.event]!.isEmpty, "an imported event would show twice in Calendar")
        XCTAssertTrue(store.sourceEvents["e1"]!.item.snapshot.url == nil, "import never writes to the source calendar")
        XCTAssertNil(sync.lastError)
    }

    func testOnlyNewUpcomingOneOffEventsAreImported() async throws {
        let store = FakeItemStore()
        store.calendars = [boss, AppleCalendarInfo(identifier: "test-home", title: "TodoCue (tmp.x1y2)", sourceTitle: "iCloud"),
                           AppleCalendarInfo(identifier: "douyin", title: "抖音春节活动", sourceTitle: "iCloud")]
        add(store, "past", title: "已经结束", start: "2026-10-01T08:00:00Z")
        add(store, "weekly", title: "周会", recurring: true)
        add(store, "mirror", title: "别的 TodoCue 的镜像", url: "todocue://task/t_other")
        add(store, "isolated", title: "测试数据目录的日历", calendar: "test-home")
        add(store, "excluded", title: "春节活动", calendar: "douyin")
        add(store, "allDay", title: "全天", start: "2026-10-04T00:00:00Z")
        store.sourceEvents["allDay"]!.item.snapshot.start = .day("2026-10-04")
        store.sourceEvents["allDay"]!.item.snapshot.end = .day("2026-10-04")
        let backend = FakeBackend([])
        let sync = make(store, backend)
        sync.setCalendarIncluded("douyin", false)
        await sync.syncNow()

        XCTAssertEqual(backend.calls, ["create 全天"])
        XCTAssertEqual(backend.todo.first?.scheduledDate, "2026-10-04")
        XCTAssertEqual(sync.importCalendars.map(\.identifier), ["boss", "douyin"])
    }

    func testEditsThereFollowUnlessTodoCueChangedTheField() async throws {
        let store = FakeItemStore()
        store.calendars = [boss]
        add(store, "e1", title: "视频面试")
        let backend = FakeBackend([])
        let sync = make(store, backend)
        await sync.syncNow()
        let id = try XCTUnwrap(backend.todo.first?.id)

        edit(store, "e1") { $0.start = .at(TCDate.parse("2026-10-10T02:00:00Z")!); $0.end = .at(TCDate.parse("2026-10-10T03:00:00Z")!) }
        await sync.syncNow()
        XCTAssertEqual(backend[id]?.scheduledAt.flatMap(AppleDateValue.at), at("2026-10-10T02:00:00Z"))
        XCTAssertEqual(backend[id]?.estimateMinutes, 60)

        backend.touch(id) { $0.title = "面试：准备作品集" }
        await sync.syncNow()
        XCTAssertEqual(backend.calls, ["create 视频面试", "update \(id)"], "a TodoCue edit alone writes nothing back")

        edit(store, "e1") { $0.title = "视频面试（改）"; $0.start = .at(TCDate.parse("2026-10-11T02:00:00Z")!); $0.end = .at(TCDate.parse("2026-10-11T03:00:00Z")!) }
        await sync.syncNow()
        XCTAssertEqual(backend[id]?.title, "面试：准备作品集", "TodoCue's own title wins")
        XCTAssertEqual(backend[id]?.scheduledAt.flatMap(AppleDateValue.at), at("2026-10-11T02:00:00Z"))

        // …and keeps winning on the next edit there.
        edit(store, "e1") { $0.title = "视频面试（再改）" }
        await sync.syncNow()
        XCTAssertEqual(backend[id]?.title, "面试：准备作品集")
        XCTAssertNil(sync.lastError)
    }

    func testEventDeletedThereCancelsTheTaskAfterTheGracePeriod() async throws {
        let store = FakeItemStore()
        store.calendars = [boss]
        add(store, "e1", title: "视频面试")
        let backend = FakeBackend([])
        let sync = make(store, backend)
        await sync.syncNow()
        let id = try XCTUnwrap(backend.todo.first?.id)

        store.sourceEvents["e1"] = nil
        await sync.syncNow()
        XCTAssertEqual(backend[id]?.status, .todo)
        XCTAssertNotNil(sync.imports.first?.missingSince)

        advance(minutes: 11)
        await sync.syncNow()
        XCTAssertEqual(backend[id]?.status, .cancelled, "cancelled, not deleted: it stays reopenable")
        XCTAssertEqual(backend.calls, ["create 视频面试", "cancel \(id)"])

        await sync.syncNow()
        XCTAssertEqual(sync.imports.first?.cancelledByImport, true, "kept while the event could still come back")

        advance(minutes: 7 * 24 * 60)
        await sync.syncNow()
        XCTAssertTrue(sync.imports.isEmpty, "dropped once the event, as last seen, is over")
    }

    func testEventBackBeforeTheGracePeriodKeepsTheTask() async throws {
        let store = FakeItemStore()
        store.calendars = [boss]
        let event = add(store, "e1", title: "视频面试")
        let backend = FakeBackend([])
        let sync = make(store, backend)
        await sync.syncNow()
        store.sourceEvents["e1"] = nil
        await sync.syncNow()

        // Back under a new identifier (iCloud resync), found by its server id.
        var back = event
        back.item.identifier = "e1-resynced"
        store.sourceEvents["e1-resynced"] = back
        advance(minutes: 30)
        await sync.syncNow()
        XCTAssertEqual(backend.todo.count, 1)
        XCTAssertEqual(sync.imports.first?.identifier, "e1-resynced")
        XCTAssertNil(sync.imports.first?.missingSince)
        XCTAssertEqual(backend.calls, ["create 视频面试"])
    }

    func testFinishedTaskIsNotImportedAgain() async throws {
        let store = FakeItemStore()
        store.calendars = [boss]
        add(store, "e1", title: "视频面试")
        let backend = FakeBackend([])
        let sync = make(store, backend)
        await sync.syncNow()
        let id = try XCTUnwrap(backend.todo.first?.id)

        backend.touch(id) { $0.status = .done }
        await sync.syncNow()
        await sync.syncNow()
        XCTAssertNotNil(sync.imports.first?.closedAt)
        backend.removeTask(id)
        await sync.syncNow()
        XCTAssertEqual(backend.calls, ["create 视频面试"])

        // Once the event is over, the record goes.
        advance(minutes: 7 * 24 * 60)
        await sync.syncNow()
        XCTAssertTrue(sync.imports.isEmpty)
        XCTAssertEqual(backend.calls, ["create 视频面试"])
    }

    func testExcludingACalendarOrLosingItKeepsItsTasks() async throws {
        let store = FakeItemStore()
        let work = AppleCalendarInfo(identifier: "work", title: "工作", sourceTitle: "iCloud")
        store.calendars = [boss, work]
        add(store, "e1", title: "视频面试")
        add(store, "w1", title: "评审", calendar: "work")
        let backend = FakeBackend([])
        let sync = make(store, backend)
        await sync.syncNow()
        XCTAssertEqual(backend.todo.count, 2)

        sync.setCalendarIncluded("boss", false)
        // The work account is signed out: its calendar and events disappear together.
        store.calendars = [boss]
        store.sourceEvents["w1"] = nil
        await sync.syncNow()
        advance(minutes: 60)
        await sync.syncNow()

        XCTAssertEqual(backend.todo.count, 2, "neither excluding a calendar nor losing one cancels tasks")
        XCTAssertEqual(backend.calls.filter { $0.hasPrefix("cancel") }, [])
        XCTAssertNotNil(sync.imports.first { $0.identifier == "e1" }?.closedAt)
        XCTAssertNil(sync.imports.first { $0.identifier == "w1" }?.closedAt, "held, not judged, while its calendar is unreadable")

        sync.setCalendarIncluded("boss", true)
        await sync.syncNow()
        XCTAssertEqual(backend.calls.filter { $0.hasPrefix("create") }.count, 2, "taking a calendar back does not import twins")
        XCTAssertNil(sync.imports.first { $0.identifier == "e1" }?.closedAt, "…and its task follows the event again")
    }

    func testManyEventsVanishingAtOnceDoNotCancelTasks() async throws {
        let store = FakeItemStore()
        store.calendars = [boss]
        for n in 1...6 { add(store, "e\(n)", title: "面试 \(n)") }
        let backend = FakeBackend([])
        let sync = make(store, backend)
        await sync.syncNow()
        store.sourceEvents = [:]

        await sync.syncNow()
        advance(minutes: 20)
        await sync.syncNow()
        XCTAssertEqual(backend.todo.count, 6)
        XCTAssertEqual(backend.calls.filter { $0.hasPrefix("cancel") }, [])
        XCTAssertNotNil(sync.lastError)
    }

    func testEventMovedIntoTheTodoCueCalendarBecomesItsMirror() async throws {
        let store = FakeItemStore()
        store.calendars = [boss]
        let event = add(store, "e1", title: "视频面试")
        let backend = FakeBackend([])
        let sync = make(store, backend, mirror: [.event])
        await sync.syncNow()
        await sync.syncNow()
        let id = try XCTUnwrap(backend.todo.first?.id)

        store.sourceEvents["e1"] = nil
        store.items[.event]!["e1"] = FakeItemStore.Stored(snapshot: event.item.snapshot, external: "ext-e1")
        await sync.syncNow()
        await sync.syncNow()

        XCTAssertTrue(sync.imports.isEmpty)
        XCTAssertEqual(sync.links.map(\.taskId), [id])
        XCTAssertEqual(store.items[.event]!.count, 1)
        XCTAssertEqual(store.items[.event]!["e1"]?.snapshot.url, AppleSyncMapper.url(for: id))
        XCTAssertEqual(backend.calls, ["create 视频面试"], "the same task, not a second import")
    }

    // MARK: - Closed records

    func testFinishedTaskIsNotImportedAgainAfterItsEventBrieflyDisappears() async throws {
        let store = FakeItemStore()
        store.calendars = [boss]
        let event = add(store, "e1", title: "视频面试")
        let backend = FakeBackend([])
        let sync = make(store, backend)
        await sync.syncNow()
        let id = try XCTUnwrap(backend.todo.first?.id)

        backend.removeTask(id)
        await sync.syncNow()
        store.sourceEvents["e1"] = nil // an iCloud resync
        await sync.syncNow()
        store.sourceEvents["e1"] = event
        await sync.syncNow()
        // Back under brand-new identifiers, matching only by content.
        store.sourceEvents["e1"] = nil
        await sync.syncNow()
        var resynced = event
        resynced.item.identifier = "e1-new"
        resynced.item.externalIdentifier = "ext-new"
        store.sourceEvents["e1-new"] = resynced
        await sync.syncNow()

        XCTAssertEqual(backend.calls, ["create 视频面试"])
        XCTAssertTrue(backend.todo.isEmpty)
    }

    func testReopenedTaskFollowsItsEventAgain() async throws {
        let store = FakeItemStore()
        store.calendars = [boss]
        add(store, "e1", title: "视频面试")
        let backend = FakeBackend([])
        let sync = make(store, backend)
        await sync.syncNow()
        let id = try XCTUnwrap(backend.todo.first?.id)

        backend.touch(id) { $0.status = .done }
        await sync.syncNow()
        XCTAssertNotNil(sync.imports.first?.closedAt)
        backend.touch(id) { $0.status = .todo } // undo completion

        edit(store, "e1") { $0.start = .at(TCDate.parse("2026-10-12T02:00:00Z")!); $0.end = .at(TCDate.parse("2026-10-12T02:30:00Z")!) }
        await sync.syncNow()
        XCTAssertNil(sync.imports.first?.closedAt)
        XCTAssertEqual(backend[id]?.scheduledAt.flatMap(AppleDateValue.at), at("2026-10-12T02:00:00Z"))
    }

    func testTaskCancelledForAVanishedEventComesBackWithIt() async throws {
        let store = FakeItemStore()
        store.calendars = [boss]
        let event = add(store, "e1", title: "视频面试")
        let backend = FakeBackend([])
        let sync = make(store, backend)
        await sync.syncNow()
        let id = try XCTUnwrap(backend.todo.first?.id)

        store.sourceEvents["e1"] = nil
        await sync.syncNow()
        advance(minutes: 11)
        await sync.syncNow()
        XCTAssertEqual(backend[id]?.status, .cancelled)

        store.sourceEvents["e1"] = event
        await sync.syncNow()
        XCTAssertEqual(backend[id]?.status, .todo)
        XCTAssertEqual(backend.calls, ["create 视频面试", "cancel \(id)", "reopen \(id)"])
        XCTAssertNil(sync.imports.first?.closedAt)

        // A task the user cancelled stays cancelled.
        backend.touch(id) { $0.status = .cancelled }
        await sync.syncNow()
        await sync.syncNow()
        XCTAssertEqual(backend[id]?.status, .cancelled)
    }

    func testTodoTaskOfAnExcludedCalendarIsNeverMirrored() async throws {
        let store = FakeItemStore()
        store.calendars = [boss]
        add(store, "e1", title: "视频面试")
        let backend = FakeBackend([])
        let sync = make(store, backend, mirror: [.event])
        await sync.syncNow()
        sync.setCalendarIncluded("boss", false)
        await sync.syncNow()

        advance(minutes: 14 * 24 * 60) // long after the event
        await sync.syncNow()
        await sync.syncNow()
        XCTAssertEqual(backend.todo.count, 1)
        XCTAssertEqual(sync.imports.count, 1, "kept while its task is a todo")
        XCTAssertTrue(store.items[.event]!.isEmpty)
    }

    // MARK: - Robustness

    func testMovedWithANewTimeKeepsTheNewTime() async throws {
        let store = FakeItemStore()
        store.calendars = [boss]
        var event = add(store, "e1", title: "视频面试")
        let backend = FakeBackend([])
        let sync = make(store, backend, mirror: [.event])
        await sync.syncNow()
        await sync.syncNow()
        let id = try XCTUnwrap(backend.todo.first?.id)

        // One save in Calendar: new time and new calendar.
        store.sourceEvents["e1"] = nil
        let start = TCDate.parse("2026-10-09T10:00:00Z")!
        event.item.snapshot.start = .at(start)
        event.item.snapshot.end = .at(start.addingTimeInterval(30 * 60))
        store.items[.event]!["e1"] = FakeItemStore.Stored(snapshot: event.item.snapshot, external: "ext-e1")
        await sync.syncNow()
        await sync.syncNow()

        XCTAssertEqual(backend[id]?.scheduledAt.flatMap(AppleDateValue.at), at("2026-10-09T10:00:00Z"))
        XCTAssertEqual(store.items[.event]!["e1"]?.snapshot.start, at("2026-10-09T10:00:00Z"))
        XCTAssertEqual(store.items[.event]!["e1"]?.snapshot.url, AppleSyncMapper.url(for: id))
        XCTAssertEqual(sync.links.map(\.taskId), [id])
        XCTAssertEqual(backend.calls, ["create 视频面试", "update \(id)"])
    }

    func testExclusionFollowsACalendarEventKitGaveANewIdentifier() async throws {
        let store = FakeItemStore()
        let calA = AppleCalendarInfo(identifier: "cal-a", title: "Calendar", sourceTitle: "iCloud")
        let calB = AppleCalendarInfo(identifier: "cal-b", title: "Calendar", sourceTitle: "iCloud")
        let work = AppleCalendarInfo(identifier: "work", title: "工作", sourceTitle: "iCloud")
        store.calendars = [calA, calB, work]
        let backend = FakeBackend([])
        let sync = make(store, backend)
        await sync.syncNow()
        sync.setCalendarIncluded("work", false)
        sync.setCalendarIncluded("cal-a", false)
        await sync.syncNow()

        // A full sync: "工作" comes back as a new calendar; "cal-a" is deleted outright.
        let work2 = AppleCalendarInfo(identifier: "work-2", title: "工作", sourceTitle: "iCloud")
        store.calendars = [calB, work2]
        add(store, "w1", title: "评审", calendar: "work-2")
        add(store, "b1", title: "看牙", calendar: "cal-b")
        await sync.syncNow()

        XCTAssertEqual(backend.calls, ["create 看牙"], "the renamed exclusion holds; a calendar already seen included stays included")
        XCTAssertEqual(sync.excludedCalendars, ["cal-a", "work-2"])
    }

    func testRecordsLiveOutsideTheFileOlderClientsRewrite() async throws {
        let store = FakeItemStore()
        store.calendars = [boss]
        add(store, "e1", title: "视频面试")
        let backend = FakeBackend([])
        let sync = make(store, backend)
        await sync.syncNow()

        let main = try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("apple-sync.json"))) as? [String: Any]
        XCTAssertNil(main?["imports"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("apple-calendar-import.json").path))
        let reloaded = AppleSyncState.load(from: dir.appendingPathComponent("apple-sync.json"))
        XCTAssertEqual(reloaded.imports?.map(\.identifier), ["e1"])
    }

    func testOneCalendarEmptyingOutIsHeldEvenWhenSmallOverall() async throws {
        let store = FakeItemStore()
        let work = AppleCalendarInfo(identifier: "work", title: "工作", sourceTitle: "iCloud")
        store.calendars = [boss, work]
        for n in 1...20 { add(store, "b\(n)", title: "面试 \(n)") }
        for n in 1...5 { add(store, "w\(n)", title: "评审 \(n)", calendar: "work") }
        let backend = FakeBackend([])
        let sync = make(store, backend)
        await sync.syncNow()
        XCTAssertEqual(backend.todo.count, 25)

        for n in 1...5 { store.sourceEvents["w\(n)"] = nil }
        await sync.syncNow()
        advance(minutes: 20)
        await sync.syncNow()
        XCTAssertEqual(backend.calls.filter { $0.hasPrefix("cancel") }, [], "5 of 25 is under the overall limit, but all of one calendar")
        XCTAssertNotNil(sync.lastError)
    }

    func testClientWithoutImportSettingsNeverImports() async throws {
        let store = FakeItemStore()
        store.calendars = [boss]
        add(store, "e1", title: "视频面试")
        let backend = FakeBackend([])
        let sync = make(store, backend, mirror: [.event], supportsImport: false)
        await sync.syncNow()
        XCTAssertFalse(sync.isImportEnabled)
        XCTAssertEqual(backend.calls, [])
        XCTAssertTrue(sync.importCalendars.isEmpty)
    }

    func testTurningImportOnAsksForCalendarAccessAndOffKeepsTasks() async throws {
        let store = FakeItemStore()
        store.calendars = [boss]
        add(store, "e1", title: "视频面试")
        let backend = FakeBackend([])
        let sync = AppleSyncController(store: store, stateURL: dir.appendingPathComponent("apple-sync.json"), defaults: defaults,
                                       client: "desktop", backend: { backend }, todoTasks: { backend.todo })
        sync.supportsImport = true
        sync.now = { [unowned self] in self.clock }

        store.granted = false
        let refused = await sync.setImportEnabled(true)
        XCTAssertNotNil(refused)
        XCTAssertFalse(sync.isImportEnabled)

        store.granted = true
        let message = await sync.setImportEnabled(true)
        XCTAssertNil(message)
        XCTAssertEqual(backend.calls, ["create 视频面试"])

        await sync.setImportEnabled(false)
        add(store, "e2", title: "第二场面试")
        await sync.syncNow()
        XCTAssertEqual(backend.todo.count, 1)
        XCTAssertEqual(sync.imports.count, 1, "records stay so turning it back on imports nothing twice")
    }
}
