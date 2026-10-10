import XCTest
import AppKit
import SwiftUI
import ScreenCaptureKit
import TodoCueKit
@testable import TodoCue

final class FormInteractionTests: XCTestCase {
    @MainActor private func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap(descendants)
    }

    @MainActor private func panel(_ model: AppModel) -> SidePanelController {
        _ = NSApplication.shared
        let name = "todocue-form-interaction-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.set(480.0, forKey: "panelWidth")
        defaults.set(680.0, forKey: "panelHeight")
        let panel = SidePanelController(model: model, defaults: defaults)
        defaults.removePersistentDomain(forName: name)
        panel.show(focusInput: true)
        return panel
    }

    @MainActor private func settle(_ panel: SidePanelController) async throws {
        try await Task.sleep(nanoseconds: 250_000_000)
        panel.window.contentView?.layoutSubtreeIfNeeded()
    }

    @MainActor func testSwitchingFormsReplacesNativeFieldContentsAndKeepsTypingState() async throws {
        let model = AppModel()
        var first = TaskDraft(); first.title = "第一条任务"; first.notes = "旧备注不会串到下一条"
        model.presentForm(first)
        let panel = panel(model)
        defer { panel.window.orderOut(nil) }
        try await settle(panel)
        let root = try XCTUnwrap(panel.window.contentView)
        let fields = descendants(root).compactMap { $0 as? NSTextField }
        XCTAssertTrue(fields.contains { $0.stringValue == first.notes }, "the real AppKit notes field must be mounted")
        let editor = try XCTUnwrap(panel.window.firstResponder as? NSTextView)
        editor.selectAll(nil)
        editor.insertText("实际键盘输入", replacementRange: editor.selectedRange())
        try await settle(panel)
        guard case .form(let typed) = model.routes.last else { return XCTFail("missing form") }
        XCTAssertEqual(typed.title, "实际键盘输入")
        var second = TaskDraft(); second.title = "第二条任务"; second.notes = "新备注"
        model.presentForm(second)
        try await settle(panel)
        let changed = descendants(root).compactMap { $0 as? NSTextField }
        XCTAssertTrue(changed.contains { $0.stringValue == second.notes })
        XCTAssertFalse(changed.contains { $0.stringValue == first.notes })
        model.pop()
        try await settle(panel)
        XCTAssertTrue(descendants(root).compactMap { $0 as? NSTextField }.contains { $0.stringValue == typed.title })
    }

    @MainActor func testReturnKeysInsertNewlinesWhereExpected() async throws {
        let model = AppModel(client: APIClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "fixture"))
        var draft = TaskDraft(); draft.title = "标题"; draft.notes = "备注"
        model.presentForm(draft)
        let panel = panel(model)
        defer { panel.window.orderOut(nil) }
        try await settle(panel)
        let root = try XCTUnwrap(panel.window.contentView)
        func press(_ flags: NSEvent.ModifierFlags, in text: String, marked: Bool = false) async throws -> TaskDraft {
            let field = try XCTUnwrap(descendants(root).compactMap { $0 as? NSTextField }.first { $0.stringValue == text })
            field.selectText(nil)
            let editor = try XCTUnwrap(panel.window.firstResponder as? NSTextView)
            editor.setSelectedRange(NSRange(location: 1, length: 0))
            if marked { editor.setMarkedText("pin", selectedRange: NSRange(location: 3, length: 0), replacementRange: editor.selectedRange()) }
            panel.window.sendEvent(try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.window.windowNumber, context: nil,
                characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36)))
            if marked { editor.unmarkText() }
            try await settle(panel)
            guard case .form(let typed) = model.routes.last else { throw XCTSkip("missing form") }
            return typed
        }
        var typed = try await press(.shift, in: "备注")
        XCTAssertEqual(typed.notes, "备\n注", "Shift-Return inserts at the caret")
        typed = try await press([], in: "备\n注")
        XCTAssertEqual(typed.notes, "备\n\n注", "plain Return breaks lines in notes")
        typed = try await press(.shift, in: "标题")
        XCTAssertEqual(typed.title, "标\n题")
        typed = try await press([], in: "标\n题")
        XCTAssertEqual(typed.title, "标\n题", "plain Return keeps ending title editing")
        typed = try await press([], in: "备\n\n注", marked: true)
        XCTAssertFalse(typed.notes.contains("\n\n\n"), "Return while an input method composes commits instead of breaking the line")
    }

    @MainActor func testNotesSelectionDragDoesNotMoveWindowAndHeaderHasDragArea() async throws {
        _ = NSApplication.shared
        let model = AppModel(client: APIClient(baseURL: URL(string: "http://127.0.0.1:1")!, token: "fixture"))
        let originalAppearance = NSApp.appearance
        defer { NSApp.appearance = originalAppearance }
        NSApp.appearance = NSAppearance(named: .aqua)
        var draft = TaskDraft(); draft.title = "拖选文字"; draft.notes = "Select some of these notes with the mouse"
        model.presentForm(draft)
        let panel = panel(model)
        defer { panel.window.orderOut(nil) }
        try await settle(panel)
        XCTAssertFalse(panel.window.isMovableByWindowBackground)
        let root = try XCTUnwrap(panel.window.contentView)
        let dragArea = try XCTUnwrap(descendants(root).first { $0 is PanelDragArea.DragView })
        XCTAssertGreaterThan(dragArea.bounds.width, 20)
        let headerPoint = root.convert(NSPoint(x: dragArea.bounds.midX, y: dragArea.bounds.midY), from: dragArea)
        XCTAssertTrue(root.hitTest(headerPoint) is PanelDragArea.DragView)
        let field = try XCTUnwrap(descendants(root).compactMap { $0 as? NSTextField }.first { $0.stringValue == draft.notes })
        field.selectText(nil)
        let editor = try XCTUnwrap(panel.window.firstResponder as? NSTextView)
        editor.setSelectedRange(NSRange(location: 0, length: 0))
        let layout = try XCTUnwrap(editor.layoutManager)
        let container = try XCTUnwrap(editor.textContainer)
        layout.ensureLayout(for: container)
        let glyphs = layout.glyphRange(forCharacterRange: NSRange(location: 0, length: 15), actualCharacterRange: nil)
        let rect = layout.boundingRect(forGlyphRange: glyphs, in: container).offsetBy(dx: editor.textContainerOrigin.x, dy: editor.textContainerOrigin.y)
        let start = editor.convert(NSPoint(x: rect.minX + 1, y: rect.midY), to: nil)
        let end = editor.convert(NSPoint(x: rect.maxX - 1, y: rect.midY), to: nil)
        let before = panel.window.frame
        func event(_ type: NSEvent.EventType, _ point: NSPoint) throws -> NSEvent {
            try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.window.windowNumber,
                context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1))
        }
        // AppKit's mouseDown tracks selection synchronously, consuming the queued drag and up.
        NSApp.postEvent(try event(.leftMouseUp, end), atStart: true)
        NSApp.postEvent(try event(.leftMouseDragged, end), atStart: true)
        panel.window.sendEvent(try event(.leftMouseDown, start))
        XCTAssertGreaterThan(editor.selectedRange().length, 0)
        XCTAssertEqual(panel.window.frame, before)
        if let output = ProcessInfo.processInfo.environment["TODOCUE_FORM_SCREENSHOT"] {
            let backdrop = NSWindow(contentRect: NSScreen.main!.frame, styleMask: .borderless, backing: .buffered, defer: false)
            backdrop.isReleasedWhenClosed = false
            backdrop.backgroundColor = .white
            backdrop.orderFrontRegardless()
            panel.window.orderFrontRegardless()
            defer { backdrop.orderOut(nil) }
            try await settle(panel)
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            let window = try XCTUnwrap(content.windows.first { $0.windowID == CGWindowID(panel.window.windowNumber) })
            let background = try XCTUnwrap(content.windows.first { $0.windowID == CGWindowID(backdrop.windowNumber) })
            let display = try XCTUnwrap(content.displays.first { $0.frame.contains(window.frame.origin) })
            let filter = SCContentFilter(display: display, including: [background, window])
            let config = SCStreamConfiguration()
            config.width = Int(panel.window.frame.width * 2)
            config.height = Int(panel.window.frame.height * 2)
            config.sourceRect = CGRect(x: window.frame.minX - display.frame.minX, y: window.frame.minY - display.frame.minY,
                                       width: window.frame.width, height: window.frame.height)
            config.showsCursor = false
            let screenshot = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            try XCTUnwrap(NSBitmapImageRep(cgImage: screenshot).representation(using: .png, properties: [:]))
                .write(to: URL(fileURLWithPath: output))
        }
    }
}
