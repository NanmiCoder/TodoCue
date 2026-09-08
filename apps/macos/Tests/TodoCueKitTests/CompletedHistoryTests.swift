import XCTest
@testable import TodoCueKit

final class CompletedHistoryTests: XCTestCase {
    private func done(_ id: String, completedAt: String?, scheduledDate: String? = nil,
                      title: String = "写周报", project: String? = nil, notes: String? = nil,
                      timezone: String = "Asia/Shanghai") -> TodoTask {
        TodoTask(id: id, title: title, notes: notes, project: project, scheduledDate: scheduledDate,
                 timezone: timezone, status: .done, completedAt: completedAt,
                 createdAt: "2026-09-01T00:00:00Z", updatedAt: completedAt ?? "2026-09-01T00:00:00Z")
    }

    func testGroupingIsByCompletionDateNotPlanDate() {
        // The whole reason this view cannot use `listTasks`' from/to: those filter on `planDate`,
        // and a task scheduled years ago can be finished today.
        let old = done("a", completedAt: "2026-09-08T02:00:00.000Z", scheduledDate: "2020-01-01")
        let days = CompletedHistory.days([old], timezone: "Asia/Shanghai")
        XCTAssertEqual(days.map(\.date), ["2026-09-08"])
        XCTAssertEqual(old.planDate, "2020-01-01", "its plan date is somewhere else entirely")
    }

    func testDaysAreNewestFirstAndKeepTheRuntimeOrderInsideADay() {
        let tasks = [done("a", completedAt: "2026-09-08T10:00:00.000Z"),
                     done("b", completedAt: "2026-09-08T09:00:00.000Z"),
                     done("c", completedAt: "2026-09-06T09:00:00.000Z")]
        let days = CompletedHistory.days(tasks, timezone: "Asia/Shanghai")
        XCTAssertEqual(days.map(\.date), ["2026-09-08", "2026-09-06"])
        XCTAssertEqual(days.first?.tasks.map(\.id), ["a", "b"], "the runtime already ordered these")
    }

    func testTheDayIsResolvedInTheRuntimeZone() {
        // 2026-09-08T18:00Z is the 9th in Shanghai and still the 8th in New York.
        let task = done("a", completedAt: "2026-09-08T18:00:00.000Z")
        XCTAssertEqual(CompletedHistory.completionDate(task, timezone: "Asia/Shanghai"), "2026-09-09")
        XCTAssertEqual(CompletedHistory.completionDate(task, timezone: "America/New_York"), "2026-09-08")
    }

    func testATaskWithoutACompletionStampFallsBackToItsUpdateTime() {
        var task = done("a", completedAt: nil)
        task.updatedAt = "2026-09-07T01:00:00.000Z"
        XCTAssertEqual(CompletedHistory.completionDate(task, timezone: "Asia/Shanghai"), "2026-09-07")
        XCTAssertEqual(CompletedHistory.days([task], timezone: "Asia/Shanghai").count, 1,
                       "it must still be reachable rather than silently dropped")
    }

    func testSearchCoversTitleProjectAndNotesAndIgnoresCase() {
        let tasks = [done("a", completedAt: "2026-09-08T02:00:00.000Z", title: "Ship the Release Notes"),
                     done("b", completedAt: "2026-09-08T02:00:00.000Z", title: "买咖啡豆", project: "生活"),
                     done("c", completedAt: "2026-09-08T02:00:00.000Z", title: "复盘", notes: "整理本周反馈")]
        XCTAssertEqual(CompletedHistory.matching(tasks, query: "release").map(\.id), ["a"])
        XCTAssertEqual(CompletedHistory.matching(tasks, query: "生活").map(\.id), ["b"])
        XCTAssertEqual(CompletedHistory.matching(tasks, query: "反馈").map(\.id), ["c"])
        XCTAssertEqual(CompletedHistory.matching(tasks, query: "   ").count, 3, "a blank query filters nothing")
        XCTAssertTrue(CompletedHistory.matching(tasks, query: "没有这个").isEmpty)
    }

    /// `ListTasksQuery.limit` is `max(1000)` and the server parses rather than clamps, so a probe of
    /// 1001 is a hard validation error. Assert the value actually sent, at every window the paging
    /// can reach — the earlier version of this test asserted only the constant and missed it.
    func testTheProbeNeverExceedsTheSchemaLimitAtAnyReachableWindow() {
        var window = CompletedHistory.pageSize
        var seen: [Int] = []
        while window < CompletedHistory.maxWindow {
            seen.append(CompletedHistory.probe(window: window))
            window = min(window + CompletedHistory.pageSize, CompletedHistory.maxWindow)
        }
        seen.append(CompletedHistory.probe(window: window))
        XCTAssertEqual(window, CompletedHistory.maxWindow, "paging must actually reach the ceiling")
        for probe in seen { XCTAssertLessThanOrEqual(probe, 1000, "limit=\(probe) would be rejected") }
        XCTAssertGreaterThanOrEqual(seen.count, 2)
    }

    func testHasMoreIsFalseAtTheCeilingSoTheButtonCannotSpinForever() {
        XCTAssertTrue(CompletedHistory.hasMore(window: 60, received: 61))
        XCTAssertFalse(CompletedHistory.hasMore(window: 60, received: 60))
        // At the ceiling the probe equals the window, so "more" is unknowable and must not be
        // claimed — otherwise the load-earlier button stays and every tap re-fetches the same page.
        XCTAssertEqual(CompletedHistory.probe(window: CompletedHistory.maxWindow), CompletedHistory.maxWindow)
        XCTAssertFalse(CompletedHistory.hasMore(window: CompletedHistory.maxWindow,
                                                received: CompletedHistory.maxWindow))
    }

    func testMergingRemovesATaskThatIsNoLongerDone() {
        let list = [done("a", completedAt: "2026-09-08T03:00:00.000Z"),
                    done("b", completedAt: "2026-09-08T02:00:00.000Z")]
        var reopened = list[0]
        reopened.status = .todo
        XCTAssertEqual(CompletedHistory.merging(list, with: reopened, hasMore: false).map(\.id), ["b"])
        // Cancelling has the same effect: this page only holds finished work.
        var cancelled = list[1]
        cancelled.status = .cancelled
        XCTAssertEqual(CompletedHistory.merging(list, with: cancelled, hasMore: false).map(\.id), ["a"])
    }

    func testMergingUpdatesAKnownTaskInPlaceWithoutReordering() {
        let list = [done("a", completedAt: "2026-09-08T03:00:00.000Z"),
                    done("b", completedAt: "2026-09-08T02:00:00.000Z")]
        var edited = list[1]
        edited.title = "改过标题"
        let merged = CompletedHistory.merging(list, with: edited, hasMore: false)
        XCTAssertEqual(merged.map(\.id), ["a", "b"])
        XCTAssertEqual(merged[1].title, "改过标题")
    }

    func testANewlyFinishedTaskLandsInCompletionOrderNotAlwaysAtTheTop() {
        let list = [done("a", completedAt: "2026-09-08T03:00:00.000Z"),
                    done("c", completedAt: "2026-09-08T01:00:00.000Z")]
        let middle = done("b", completedAt: "2026-09-08T02:00:00.000Z")
        XCTAssertEqual(CompletedHistory.merging(list, with: middle, hasMore: false).map(\.id), ["a", "b", "c"])
        let newest = done("z", completedAt: "2026-09-08T09:00:00.000Z")
        XCTAssertEqual(CompletedHistory.merging(list, with: newest, hasMore: false).map(\.id), ["z", "a", "c"])
        XCTAssertEqual(CompletedHistory.merging([], with: newest, hasMore: true).map(\.id), ["z"])
    }

    func testATaskOlderThanThePageIsRefusedWhileMorePagesExist() {
        // Editing a done task from an older day — the calendar offers that — must not graft on a
        // day group older than anything fetched, or the history looks deeper than it is.
        let list = [done("a", completedAt: "2026-09-08T03:00:00.000Z"),
                    done("b", completedAt: "2026-09-08T02:00:00.000Z")]
        let ancient = done("old", completedAt: "2025-01-01T00:00:00.000Z")
        XCTAssertEqual(CompletedHistory.merging(list, with: ancient, hasMore: true).map(\.id), ["a", "b"])
        // Once the whole history is loaded there is nothing below it, so it can be adopted.
        XCTAssertEqual(CompletedHistory.merging(list, with: ancient, hasMore: false).map(\.id),
                       ["a", "b", "old"])
    }
}
