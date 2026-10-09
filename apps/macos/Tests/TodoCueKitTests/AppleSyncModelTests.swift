import XCTest
@testable import TodoCueKit

final class AppleSyncModelTests: XCTestCase {
    private func task(_ id: String = "t1", title: String = "写周报", status: TaskStatus = .todo,
                      scheduledDate: String? = nil, scheduledAt: String? = nil, dueDate: String? = nil,
                      dueAt: String? = nil, estimate: Int? = nil, priority: Priority = .none,
                      version: Int = 1, completedAt: String? = nil) -> TodoTask {
        TodoTask(id: id, title: title, priority: priority, estimateMinutes: estimate, scheduledDate: scheduledDate,
                 scheduledAt: scheduledAt, dueDate: dueDate, dueAt: dueAt, timezone: "Asia/Shanghai", status: status,
                 completedAt: completedAt, version: version, createdAt: "2026-10-01T00:00:00.000Z",
                 updatedAt: "2026-10-01T00:00:00.000Z")
    }

    // MARK: - Mapping

    func testTimedEventUsesPlanAndEstimate() {
        let s = AppleSyncMapper.snapshot(for: task(scheduledAt: "2026-10-09T01:00:00.000Z", estimate: 45), kind: .event)
        XCTAssertEqual(s?.start, .instant("2026-10-09T01:00:00.000Z"))
        XCTAssertEqual(s?.end, .instant("2026-10-09T01:45:00.000Z"))
        XCTAssertEqual(s?.url, "todocue://task/t1")
    }

    func testEventDefaultsToThirtyMinutesAndAllDayForDates() {
        let timed = AppleSyncMapper.snapshot(for: task(scheduledAt: "2026-10-09T01:00:00Z"), kind: .event)
        XCTAssertEqual(timed?.end, .instant("2026-10-09T01:30:00.000Z"))
        let day = AppleSyncMapper.snapshot(for: task(scheduledDate: "2026-10-09"), kind: .event)
        XCTAssertEqual(day?.start, .day("2026-10-09"))
        XCTAssertEqual(day?.end, .day("2026-10-09"))
    }

    func testEventPrefersPlanOverDeadlineAndFallsBackToDeadline() {
        let both = task(scheduledDate: "2026-10-09", dueDate: "2026-10-12")
        XCTAssertEqual(AppleSyncMapper.snapshot(for: both, kind: .event)?.start, .day("2026-10-09"))
        XCTAssertEqual(AppleSyncMapper.snapshot(for: task(dueAt: "2026-10-12T10:00:00Z"), kind: .event)?.start,
                       .instant("2026-10-12T10:00:00.000Z"))
        XCTAssertNil(AppleSyncMapper.snapshot(for: task(), kind: .event))
    }

    func testReminderPrefersDeadlineAndCarriesStatusAndPriority() {
        let both = task(status: .done, scheduledDate: "2026-10-09", dueDate: "2026-10-12", priority: .high)
        let s = AppleSyncMapper.snapshot(for: both, kind: .reminder)
        XCTAssertEqual(s?.due, .day("2026-10-12"))
        XCTAssertEqual(s?.priority, 1)
        XCTAssertEqual(s?.isCompleted, true)
        XCTAssertNil(AppleSyncMapper.snapshot(for: task(), kind: .reminder)?.due)
    }

    func testInstantsCompareAtMinutePrecision() {
        XCTAssertEqual(AppleDateValue.at("2026-10-09T01:00:42.512Z"), .instant("2026-10-09T01:00:00.000Z"))
    }

    func testURLRoundTrip() {
        XCTAssertEqual(AppleSyncMapper.taskId(fromURL: AppleSyncMapper.url(for: "abc")), "abc")
        XCTAssertNil(AppleSyncMapper.taskId(fromURL: "https://example.com/abc"))
        XCTAssertNil(AppleSyncMapper.taskId(fromURL: "todocue://task/"))
    }

    // MARK: - Reverse patch

    func testMovingTimedEventToAllDayKeepsFieldsExclusive() {
        let t = task(scheduledAt: "2026-10-09T01:00:00Z")
        var item = AppleSyncMapper.snapshot(for: t, kind: .event)!
        item.start = .day("2026-10-10"); item.end = .day("2026-10-10")
        let p = AppleSyncMapper.patch(from: item, task: t, kind: .event)
        XCTAssertEqual(p.fields["scheduledDate"], .string("2026-10-10"))
        XCTAssertEqual(p.fields["scheduledAt"], .null)
        XCTAssertNil(p.fields["dueDate"])
    }

    func testEventEditsGoToTheAnchorAndDuration() {
        let t = task(dueAt: "2026-10-12T10:00:00Z")
        var item = AppleSyncMapper.snapshot(for: t, kind: .event)!
        item.start = .instant("2026-10-12T11:00:00.000Z"); item.end = .instant("2026-10-12T12:00:00.000Z")
        item.title = "写月报"
        let p = AppleSyncMapper.patch(from: item, task: t, kind: .event)
        XCTAssertEqual(p.fields["dueAt"], .string("2026-10-12T11:00:00.000Z"))
        XCTAssertEqual(p.fields["dueDate"], .null)
        XCTAssertEqual(p.fields["estimateMinutes"], .int(60))
        XCTAssertEqual(p.fields["title"], .string("写月报"))
        XCTAssertNil(p.fields["scheduledAt"])
    }

    func testUnchangedItemProducesEmptyPatch() {
        for t in [task(scheduledAt: "2026-10-09T01:00:00Z", estimate: 20), task(scheduledDate: "2026-10-09"),
                  task(dueDate: "2026-10-12", priority: .medium)] {
            for kind in AppleSyncKind.allCases {
                guard let s = AppleSyncMapper.snapshot(for: t, kind: kind) else { continue }
                XCTAssertTrue(AppleSyncMapper.patch(from: s, task: t, kind: kind).fields.isEmpty, "\(t) \(kind)")
            }
        }
    }

    func testClearingReminderDateClearsTheAnchor() {
        let t = task(dueDate: "2026-10-12")
        var item = AppleSyncMapper.snapshot(for: t, kind: .reminder)!
        item.due = nil
        item.priority = 9
        let p = AppleSyncMapper.patch(from: item, task: t, kind: .reminder)
        XCTAssertEqual(p.fields["dueDate"], .null)
        XCTAssertEqual(p.fields["dueAt"], .null)
        XCTAssertEqual(p.fields["priority"], .string("low"))
    }

    func testImportedItemsBecomePlans() {
        let event = AppleItemSnapshot(title: "看牙", start: .instant("2026-10-09T01:00:00.000Z"),
                                      end: .instant("2026-10-09T02:30:00.000Z"))
        let p = AppleSyncMapper.createPayload(from: event, kind: .event)
        XCTAssertEqual(p.fields["scheduledAt"], .string("2026-10-09T01:00:00.000Z"))
        XCTAssertEqual(p.fields["estimateMinutes"], .int(90))
        let reminder = AppleItemSnapshot(title: "买牛奶", due: .day("2026-10-10"))
        XCTAssertEqual(AppleSyncMapper.createPayload(from: reminder, kind: .reminder).fields["scheduledDate"], .string("2026-10-10"))
    }

    // MARK: - Planner

    private func link(_ t: TodoTask, _ kind: AppleSyncKind, id: String = "i1", version: Int? = nil) -> (AppleSyncLink, AppleItem) {
        let s = AppleSyncMapper.snapshot(for: t, kind: kind)!
        return (AppleSyncLink(kind: kind, taskId: t.id, identifier: id, externalIdentifier: "ext-\(id)",
                              taskVersion: version ?? t.version, lastSnapshot: s, lastDesired: s),
                AppleItem(identifier: id, externalIdentifier: "ext-\(id)", snapshot: s))
    }

    func testNewDatedTodoIsCreatedAndUndatedIsNot() {
        let dated = task("a", scheduledDate: "2026-10-09"), undated = task("b")
        let actions = AppleSyncPlanner.plan(kind: .event, tasks: ["a": dated, "b": undated], links: [], items: [])
        XCTAssertEqual(actions, [.create(taskId: "a")])
    }

    func testAgreementProducesNoActions() {
        let t = task(scheduledDate: "2026-10-09")
        let (l, item) = link(t, .event)
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .event, tasks: [t.id: t], links: [l], items: [item]), [])
    }

    func testTodoCueChangeIsPushed() {
        let old = task(scheduledDate: "2026-10-09")
        let (l, item) = link(old, .event)
        let new = task(title: "改了", scheduledDate: "2026-10-09", version: 2)
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .event, tasks: [new.id: new], links: [l], items: [item]),
                       [.push(taskId: "t1", identifier: "i1")])
    }

    func testAppleChangeIsPulled() {
        let t = task(scheduledDate: "2026-10-09")
        let (l, original) = link(t, .event)
        var item = original
        item.snapshot.start = .day("2026-10-11")
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .event, tasks: [t.id: t], links: [l], items: [item]),
                       [.pull(taskId: "t1", identifier: "i1")])
    }

    func testBothChangedIsMergedThroughPull() {
        let old = task(scheduledDate: "2026-10-09")
        let (l, original) = link(old, .event)
        var item = original
        item.snapshot.title = "手机上改的"
        let new = task(scheduledDate: "2026-10-12", version: 3)
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .event, tasks: [new.id: new], links: [l], items: [item]),
                       [.pull(taskId: "t1", identifier: "i1")])
    }

    func testVersionBumpWithoutVisibleChangeOnlyRebaselines() {
        let t = task(scheduledDate: "2026-10-09")
        let (l, item) = link(t, .event)
        var moved = t
        moved.version = 4 // project, snooze, ordering…
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .event, tasks: [t.id: moved], links: [l], items: [item]),
                       [.markSynced(taskId: "t1", identifier: "i1")])
    }

    func testDivergenceNobodyCausedIsLeftAlone() {
        let t = task(scheduledDate: "2026-10-09")
        var (l, item) = link(t, .event)
        item.snapshot.end = .day("2026-10-11") // multi-day on the phone, already pulled
        l.lastSnapshot = item.snapshot
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .event, tasks: [t.id: t], links: [l], items: [item]), [])
    }

    func testMergeTakesApplesFieldsUnlessTodoCueTouchedThem() {
        let base = AppleItemSnapshot(title: "原", notes: "n", due: .day("2026-10-12"), priority: 0)
        var item = base; item.title = "手机"; item.isCompleted = true; item.priority = 1
        var desired = base; desired.priority = 9; desired.due = .day("2026-10-20")
        let m = AppleSyncMapper.merged(item: item, baseline: base, desired: desired, lastDesired: base)
        XCTAssertEqual(m.title, "手机")
        XCTAssertEqual(m.isCompleted, true)
        XCTAssertEqual(m.priority, 9, "both changed: TodoCue wins")
        XCTAssertEqual(m.due, .day("2026-10-20"))
        XCTAssertEqual(AppleSyncMapper.merged(item: item, baseline: nil, desired: desired, lastDesired: nil), desired)
    }

    func testStaleBoardIsIgnored() {
        let t = task(scheduledDate: "2026-10-09", version: 2)
        let (l, item) = link(t, .event, version: 3)
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .event, tasks: [t.id: t], links: [l], items: [item]), [])
    }

    func testDeletedItemCancelsTodoTaskOnlyAfterGrace() {
        let t = task(scheduledDate: "2026-10-09")
        var (l, _) = link(t, .event)
        let now = TCDate.parse("2026-10-09T12:00:00Z")!
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .event, tasks: [t.id: t], links: [l], items: [], now: now),
                       [.markMissing(taskId: "t1")])
        l.missingSince = TCDate.iso(now.addingTimeInterval(-60))
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .event, tasks: [t.id: t], links: [l], items: [], now: now), [])
        l.missingSince = TCDate.iso(now.addingTimeInterval(-AppleSyncPlanner.missingGrace))
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .event, tasks: [t.id: t], links: [l], items: [], now: now),
                       [.cancelTask(taskId: "t1")])
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .event, tasks: [t.id: t], links: [l], items: [], departed: ["i1"], now: now),
                       [.detach(taskId: "t1")])
        let done = task(status: .done, scheduledDate: "2026-10-09")
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .reminder, tasks: [t.id: done], links: [link(done, .reminder).0], items: []),
                       [.unlink(taskId: "t1")])
    }

    func testCompletionDeletesEventButChecksReminder() {
        let t = task(scheduledDate: "2026-10-09")
        let done = task(status: .done, scheduledDate: "2026-10-09", version: 2)
        let (le, ie) = link(t, .event)
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .event, tasks: [t.id: done], links: [le], items: [ie]),
                       [.deleteItem(taskId: "t1", identifier: "i1")])
        let (lr, ir) = link(t, .reminder)
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .reminder, tasks: [t.id: done], links: [lr], items: [ir]),
                       [.push(taskId: "t1", identifier: "i1")])
        let cancelled = task(status: .cancelled, scheduledDate: "2026-10-09", version: 2)
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .reminder, tasks: [t.id: cancelled], links: [lr], items: [ir]),
                       [.deleteItem(taskId: "t1", identifier: "i1")])
    }

    func testCheckingAndUncheckingReminderIsPulled() {
        let t = task(dueDate: "2026-10-12")
        var (l, item) = link(t, .reminder)
        item.snapshot.isCompleted = true
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .reminder, tasks: [t.id: t], links: [l], items: [item]),
                       [.pull(taskId: "t1", identifier: "i1")])

        let done = task(status: .done, dueDate: "2026-10-12")
        (l, item) = link(done, .reminder)
        item.snapshot.isCompleted = false
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .reminder, tasks: [t.id: done], links: [l], items: [item]),
                       [.pull(taskId: "t1", identifier: "i1")])
    }

    func testOldCompletedReminderIsReleased() {
        let done = task(status: .done, dueDate: "2026-08-01", completedAt: "2026-08-01T00:00:00Z")
        let (l, item) = link(done, .reminder)
        let now = TCDate.parse("2026-10-09T00:00:00Z")!
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .reminder, tasks: [done.id: done], links: [l], items: [item], now: now),
                       [.unlink(taskId: "t1")])
    }

    func testEventLosingItsDateIsRemovedButReminderStays() {
        let old = task(scheduledDate: "2026-10-09")
        let undated = task(version: 2)
        let (le, ie) = link(old, .event)
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .event, tasks: [old.id: undated], links: [le], items: [ie]),
                       [.deleteItem(taskId: "t1", identifier: "i1")])
        let (lr, ir) = link(old, .reminder)
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .reminder, tasks: [old.id: undated], links: [lr], items: [ir]),
                       [.push(taskId: "t1", identifier: "i1")])
    }

    func testMissingTaskRemovesItem() {
        let t = task(scheduledDate: "2026-10-09")
        let (l, item) = link(t, .event)
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .event, tasks: [:], links: [l], items: [item]),
                       [.deleteItem(taskId: "t1", identifier: "i1")])
    }

    func testItemWithNewIdentifierIsRelinkedByURL() {
        let t = task(scheduledDate: "2026-10-09")
        let (l, item) = link(t, .event)
        let moved = AppleItem(identifier: "i2", snapshot: item.snapshot)
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .event, tasks: [t.id: t], links: [l], items: [moved]),
                       [.relink(taskId: "t1", identifier: "i2")])
    }

    func testRelinkByExternalIdentifierAndNeverToACompletedTwin() {
        let t = task(dueDate: "2026-10-12")
        let (l, item) = link(t, .reminder)
        let byServer = AppleItem(identifier: "i9", externalIdentifier: "ext-i1", snapshot: item.snapshot)
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .reminder, tasks: [t.id: t], links: [l], items: [byServer]),
                       [.relink(taskId: "t1", identifier: "i9")])
        var old = item.snapshot
        old.isCompleted = true
        old.title = "旧的"
        let completedTwin = AppleItem(identifier: "i8", snapshot: old)
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .reminder, tasks: [t.id: t], links: [l], items: [completedTwin]),
                       [.markMissing(taskId: "t1")])
    }

    func testURLsOutsideTheRuntimeAlphabetAreIgnored() {
        XCTAssertNil(AppleSyncMapper.taskId(fromURL: "todocue://task/../../v1/export"))
        XCTAssertNil(AppleSyncMapper.taskId(fromURL: "todocue://task/a?b=c"))
        XCTAssertEqual(AppleSyncMapper.taskId(fromURL: "todocue://task/01JX_ab-9"), "01JX_ab-9")
    }

    func testItemThatLostItsURLIsRelinkedByBaseline() {
        let t = task(dueDate: "2026-10-12")
        var (l, item) = link(t, .reminder)
        item.snapshot.url = nil
        l.lastSnapshot = item.snapshot
        let moved = AppleItem(identifier: "i2", snapshot: item.snapshot)
        XCTAssertEqual(AppleSyncPlanner.plan(kind: .reminder, tasks: [t.id: t], links: [l], items: [moved]),
                       [.relink(taskId: "t1", identifier: "i2")])
    }

    func testUnlinkedItemsAreAdoptedOrImported() {
        let t = task(scheduledDate: "2026-10-09")
        let mine = AppleItem(identifier: "i1", snapshot: AppleSyncMapper.snapshot(for: t, kind: .event)!)
        let phone = AppleItem(identifier: "i2", snapshot: AppleItemSnapshot(title: "手机上加的", start: .day("2026-10-10"),
                                                                           end: .day("2026-10-10")))
        let foreign = AppleItem(identifier: "i3", snapshot: AppleItemSnapshot(title: "别处的", start: .day("2026-10-10"),
                                                                             url: "todocue://task/unknown"))
        let history = AppleItem(identifier: "i4", snapshot: AppleItemSnapshot(title: "做完了", isCompleted: true))
        let actions = AppleSyncPlanner.plan(kind: .event, tasks: [t.id: t], links: [], items: [mine, phone, foreign, history])
        XCTAssertEqual(actions, [.adopt(taskId: "t1", identifier: "i1"), .importItem(identifier: "i2")])
    }
}
