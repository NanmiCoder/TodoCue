import XCTest
import TodoCueKit
@testable import TodoCue

/// Offline `AppModel()` — no client, so nothing here reaches a runtime or a database.
final class CompletedNavigationTests: XCTestCase {
    @MainActor func testOpeningCompletedDoesNotRequestKeyboardFocus() {
        let model = AppModel()
        var requestedFocus: [Bool] = []
        model.onOpenPanel = { requestedFocus.append($0) }
        model.showCompleted()
        // A read-only history has no text entry, so it must not take focus from the front app.
        XCTAssertEqual(requestedFocus, [false])
        XCTAssertEqual(model.routes.last, .completed)
        XCTAssertTrue(model.isShowingCompleted)
    }

    @MainActor func testReopeningReturnsToTheExistingPageInsteadOfStackingAnother() {
        let model = AppModel()
        model.showCompleted()
        model.routes.append(.detail("t1"))
        model.showCompleted()
        XCTAssertEqual(model.routes, [.completed])
    }

    @MainActor func testEscapePopsCompletedBeforeClosingThePanel() {
        let model = AppModel()
        var closes = 0
        model.onClosePanel = { closes += 1 }
        model.showCompleted()
        model.handleEscape()
        XCTAssertTrue(model.routes.isEmpty)
        XCTAssertEqual(closes, 0)
        model.handleEscape()
        XCTAssertEqual(closes, 1)
    }

    @MainActor func testOpenTodayClearsTheCompletedRoute() {
        let model = AppModel()
        model.showCompleted()
        model.openToday()
        XCTAssertTrue(model.routes.isEmpty)
    }

    /// Pins the guard only — the loading logic itself is covered by `CompletedHistoryTests` and,
    /// end to end against a real runtime, by `CalendarSnapshotTests`.
    @MainActor func testLoadingIsRefusedWithoutAClientAndLeavesNoPartialList() {
        let model = AppModel()
        model.showCompleted()
        model.loadCompleted(reset: true)
        XCTAssertTrue(model.completedTasks.isEmpty)
        XCTAssertFalse(model.completedHasMore)
        XCTAssertFalse(model.isLoadingCompleted)
    }

    /// Pins the guard only; window growth is covered purely in `CompletedHistoryTests`.
    @MainActor func testLoadMoreIsANoOpWhenThereIsNothingMore() {
        let model = AppModel()
        model.showCompleted()
        XCTAssertFalse(model.completedHasMore)
        model.loadMoreCompleted()
        XCTAssertTrue(model.completedTasks.isEmpty)
    }

    /// Before a context arrives the viewer's own zone and date are the only thing available; once
    /// connected both follow the runtime, which is what makes the 今天 heading agree with grouping.
    @MainActor func testTheZoneAndTodayFallBackToTheViewerUntilAContextArrives() {
        let model = AppModel()
        XCTAssertNil(model.context)
        XCTAssertEqual(model.runtimeTimezone, TimeZone.current.identifier)
        XCTAssertEqual(model.runtimeToday, TCDate.todayString())
    }
}
