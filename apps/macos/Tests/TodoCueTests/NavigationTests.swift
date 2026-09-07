import XCTest
import AppKit
@testable import TodoCue

final class NavigationTests: XCTestCase {
    @MainActor func testOnlyExplicitEditingRequestsKeyboardFocus() async {
        let model = AppModel()
        var requestedFocus: [Bool] = []
        model.onOpenPanel = { requestedFocus.append($0) }
        model.openPanel()
        model.openToday()
        model.newTask()
        model.focusQuickAdd()
        XCTAssertEqual(requestedFocus, [false, false, true, true])
    }

    @MainActor func testPanelIsNonactivatingAndDoesNotHideOnDeactivate() async {
        _ = NSApplication.shared
        let controller = SidePanelController(model: AppModel())
        XCTAssertTrue(controller.window.styleMask.contains(.nonactivatingPanel))
        XCTAssertTrue(controller.window.becomesKeyOnlyIfNeeded)
        XCTAssertFalse(controller.window.hidesOnDeactivate)
        XCTAssertTrue(controller.window.canBecomeKey)
    }

    @MainActor func testEscapeClosesOnlyExplicitlyAndPinnedPanelStays() async {
        let model = AppModel()
        var closes = 0
        model.onClosePanel = { closes += 1 }
        model.handleEscape()
        XCTAssertEqual(closes, 1)
        model.pinned = true
        model.handleEscape()
        XCTAssertEqual(closes, 1)
    }

    @MainActor func testBackAndEscapePreserveTheSameDraft() async {
        let model = AppModel()
        var draft = TaskDraft()
        draft.title = "未提交的长中文草稿"
        draft.notes = "保留备注"
        draft.repeatKind = .weekly
        draft.weekdays = [1, 3, 5]
        model.routes = [.form(draft)]
        model.pop()
        XCTAssertEqual(model.savedDraft, draft)
        model.newTask()
        XCTAssertEqual(model.routes.last, .form(draft))
        model.handleEscape()
        XCTAssertEqual(model.savedDraft, draft)
    }

    @MainActor func testSuccessfulSaveDoesNotRestoreSubmittedDraft() async {
        let model = AppModel()
        var draft = TaskDraft()
        draft.title = "已保存"
        model.routes = [.form(draft)]
        model.pop(preservingDraft: false)
        XCTAssertNil(model.savedDraft)
    }

    @MainActor func testNewShortcutKeepsActiveDraftAndQuickAddKeepsText() async {
        let model = AppModel()
        var draft = TaskDraft()
        draft.title = "正在输入"
        model.routes = [.form(draft)]
        model.newTask()
        XCTAssertEqual(model.routes.last, .form(draft))
        model.quickAddText = "还没提交的快速添加"
        model.focusQuickAdd()
        XCTAssertEqual(model.savedDraft, draft)
        XCTAssertEqual(model.quickAddText, "还没提交的快速添加")
        XCTAssertTrue(model.routes.isEmpty)
        model.quickAdd() // Offline: input must not be cleared.
        XCTAssertEqual(model.quickAddText, "还没提交的快速添加")
    }

    func testPropertyOnlyDraftIsPreservedAndWeeklyFormValidates() {
        var draft = TaskDraft()
        draft.priority = .high
        XCTAssertTrue(draft.hasContent)
        draft.title = "重复任务"
        draft.repeatKind = .weekly
        draft.weekdays = []
        XCTAssertNotNil(draft.validate())
        draft.weekdays = [1]
        XCTAssertNil(draft.validate())
    }
}
