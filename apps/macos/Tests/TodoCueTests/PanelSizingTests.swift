import XCTest
import AppKit
@testable import TodoCue

final class PanelSizingTests: XCTestCase {
    @MainActor func testFocusedMultilineEditorReflowsWithoutChangingTextOrSelection() async {
        let editor = NSTextView(frame: NSRect(x: 0, y: 0, width: 440, height: 100))
        editor.font = .systemFont(ofSize: 17)
        editor.string = String(repeating: "正在编辑的长标题应跟随窗口宽度自然换行", count: 3)
        let selection = NSRange(location: 2, length: 8)
        editor.setSelectedRange(selection)
        let text = editor.string
        let container = editor.textContainer!
        container.widthTracksTextView = false
        container.containerSize = NSSize(width: 220, height: 10_000)
        let layout = editor.layoutManager!
        layout.ensureLayout(for: container)
        let narrowHeight = layout.usedRect(for: container).height
        SidePanelController.synchronizeFieldEditor(editor)
        layout.ensureLayout(for: container)
        XCTAssertEqual(container.containerSize.width, 440)
        XCTAssertLessThan(layout.usedRect(for: container).height, narrowHeight)
        XCTAssertEqual(editor.string, text)
        XCTAssertEqual(editor.selectedRange(), selection)
        editor.setFrameSize(NSSize(width: 220, height: 100))
        SidePanelController.synchronizeFieldEditor(editor)
        layout.ensureLayout(for: container)
        XCTAssertEqual(layout.usedRect(for: container).height, narrowHeight)
    }

    @MainActor func testDoubleClickResetsWidthWithoutStartingADrag() async {
        let handle = PanelResizeHandle()
        var widths: [CGFloat] = []
        handle.onResize = { width, finished in
            XCTAssertTrue(finished)
            widths.append(width)
        }
        let event = NSEvent.mouseEvent(with: .leftMouseDown, location: .zero, modifierFlags: [],
                                      timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 2, pressure: 1)!
        handle.mouseDown(with: event)
        handle.mouseUp(with: event)
        XCTAssertEqual(widths, [340])
    }

    @MainActor func testVerticalGripResetAndAccessibility() async {
        let handle = PanelResizeHandle(vertical: true)
        var heights: [CGFloat] = []
        handle.onResize = { height, finished in
            XCTAssertTrue(finished)
            heights.append(height)
        }
        let event = NSEvent.mouseEvent(with: .leftMouseDown, location: .zero, modifierFlags: [],
                                      timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 2, pressure: 1)!
        handle.mouseDown(with: event)
        handle.mouseUp(with: event)
        XCTAssertEqual(heights, [Theme.panelHeight])
        handle.setAccessibilityValue(NSNumber(value: 900))
        XCTAssertEqual(heights.last, 900)
    }

    @MainActor func testBottomDragUsesScreenCoordinatesAcrossWindowMovement() async {
        _ = NSApplication.shared
        let window = SidePanelWindow(contentRect: CGRect(x: 100, y: 300, width: 340, height: 680),
                                     styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let handle = PanelResizeHandle(vertical: true)
        window.contentView!.addSubview(handle)
        var finishedHeight: CGFloat?
        handle.onResize = { height, finished in
            let frame = window.frame
            window.setFrame(CGRect(x: frame.minX, y: frame.maxY - height, width: frame.width, height: height), display: false)
            if finished { finishedHeight = height }
        }
        func event(_ type: NSEvent.EventType, screenY: CGFloat) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: window.convertPoint(fromScreen: CGPoint(x: 200, y: screenY)),
                               modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
                               context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        }
        handle.mouseDown(with: event(.leftMouseDown, screenY: 305))
        handle.mouseDragged(with: event(.leftMouseDragged, screenY: 205))
        XCTAssertEqual(window.frame.height, 780)
        handle.mouseDragged(with: event(.leftMouseDragged, screenY: 155))
        XCTAssertEqual(window.frame.height, 830)
        XCTAssertEqual(window.frame.maxY, 980)
        handle.mouseUp(with: event(.leftMouseUp, screenY: 155))
        XCTAssertEqual(finishedHeight, 830)
    }

    func testBottomGripKeepsTopAndWidthAndStopsAtScreenMargin() {
        let screen = CGRect(x: -100, y: -100, width: 1200, height: 1200)
        let original = CGRect(x: 200, y: 300, width: 520, height: 680)
        let taller = PanelGeometry.resizedVertically(original, to: 950, in: screen)
        XCTAssertEqual(taller.height, 950)
        XCTAssertEqual(taller.maxY, original.maxY)
        XCTAssertEqual(taller.minX, original.minX)
        XCTAssertEqual(taller.width, original.width)
        let capped = PanelGeometry.resizedVertically(original, to: 2000, in: screen)
        XCTAssertEqual(capped.minY, screen.minY + Theme.panelMargin)
        XCTAssertEqual(capped.maxY, original.maxY)
        XCTAssertEqual(PanelGeometry.resizedVertically(original, to: 100, in: screen).height, Theme.panelMinHeight)
        XCTAssertEqual(PanelGeometry.height(.nan), Theme.panelHeight)
        XCTAssertEqual(PanelGeometry.height(.infinity), Theme.panelHeight)
        XCTAssertEqual(PanelGeometry.height(900, available: 300), 300)
    }

    @MainActor func testHeightPreferenceSurvivesRecreationAndTemporaryFitting() async {
        _ = NSApplication.shared
        let name = "TodoCue.PanelHeightTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        XCTAssertEqual(Prefs.panelHeight(in: defaults), Theme.panelHeight)
        Prefs.savePanelHeight(950, in: defaults)
        let controller = SidePanelController(model: AppModel(), defaults: defaults)
        XCTAssertEqual(controller.window.frame.height, 950)
        let smallScreen = CGRect(x: 0, y: 0, width: 800, height: 600)
        let fitted = PanelGeometry.fitted(controller.window.frame, in: smallScreen)
        controller.window.setFrame(fitted, display: false)
        XCTAssertEqual(controller.window.frame.height, 576)
        XCTAssertEqual(Prefs.panelHeight(in: defaults), 950)
        let recreated = SidePanelController(model: AppModel(), defaults: defaults)
        XCTAssertEqual(recreated.window.frame.height, 950)
        recreated.window.setFrame(CGRect(x: 0, y: 0, width: 340, height: 800), display: false)
        recreated.windowDidEndLiveResize(Notification(name: NSWindow.didEndLiveResizeNotification))
        XCTAssertEqual(Prefs.panelHeight(in: defaults), 800)
    }

    func testWidthLimitsAndInvalidPreferences() {
        XCTAssertEqual(PanelGeometry.width(120), 300)
        XCTAssertEqual(PanelGeometry.width(780), 600)
        XCTAssertEqual(PanelGeometry.width(.nan), 340)
        XCTAssertEqual(PanelGeometry.width(.infinity), 340)
        XCTAssertEqual(PanelGeometry.width(420, available: 240), 240)
    }

    func testLeftGripKeepsRightEdgeAndHeightAndStopsAtScreenMargin() {
        let screen = CGRect(x: 100, y: 50, width: 900, height: 900)
        let original = CGRect(x: 180, y: 150, width: 340, height: 680)
        let wider = PanelGeometry.resized(original, to: 600, in: screen)
        XCTAssertEqual(wider.maxX, original.maxX)
        XCTAssertEqual(wider.maxY, original.maxY)
        XCTAssertEqual(wider.height, original.height)
        XCTAssertEqual(wider.minX, screen.minX + Theme.panelMargin)
        XCTAssertEqual(wider.width, 408)
        let narrower = PanelGeometry.resized(wider, to: 280, in: screen)
        XCTAssertEqual(narrower.width, 300)
        XCTAssertEqual(narrower.maxX, original.maxX)
    }

    func testScreenChangePreservesWidePanelWhenItFits() {
        let screen = CGRect(x: -1280, y: 0, width: 1280, height: 800)
        let original = CGRect(x: -550, y: 50, width: 520, height: 680)
        XCTAssertEqual(PanelGeometry.fitted(original, in: screen), original)
        let smallerScreen = CGRect(x: 0, y: 0, width: 480, height: 600)
        let fitted = PanelGeometry.fitted(original, in: smallerScreen)
        XCTAssertEqual(fitted.width, 456)
        XCTAssertEqual(fitted.height, 576)
        XCTAssertTrue(smallerScreen.insetBy(dx: 12, dy: 12).contains(fitted))
    }

    @MainActor func testUserWidthSurvivesRecreatingPanelAndAutomaticFittingDoesNotOverwriteIt() async {
        _ = NSApplication.shared
        let name = "TodoCue.PanelSizingTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        XCTAssertEqual(Prefs.panelWidth(in: defaults), 340)
        Prefs.savePanelWidth(520, in: defaults)
        let first = SidePanelController(model: AppModel(), defaults: defaults)
        XCTAssertEqual(first.window.frame.width, 520)
        XCTAssertTrue(first.window.styleMask.contains(.resizable))
        XCTAssertEqual(first.window.minSize.width, 300)
        XCTAssertEqual(first.window.maxSize.width, 600)
        first.window.setFrame(NSRect(x: 0, y: 0, width: 340, height: 680), display: false)
        XCTAssertEqual(Prefs.panelWidth(in: defaults), 520)
        let second = SidePanelController(model: AppModel(), defaults: defaults)
        XCTAssertEqual(second.window.frame.width, 520)
        second.window.setFrame(NSRect(x: 0, y: 0, width: 400, height: 680), display: false)
        second.windowDidEndLiveResize(Notification(name: NSWindow.didEndLiveResizeNotification))
        XCTAssertEqual(Prefs.panelWidth(in: defaults), 400)
    }
}
