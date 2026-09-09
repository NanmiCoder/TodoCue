import XCTest
import AppKit
import TodoCueKit
@testable import TodoCue

/// The panel is a borderless accessory window, so macOS dispatches ⌘C/⌘V/⌘X/⌘A as
/// main-menu key equivalents. Without an Edit menu the field editor never receives
/// `copy:`/`paste:` and AppKit just beeps.
final class EditMenuTests: XCTestCase {
    @MainActor
    private func installEditMenu() -> NSMenu? {
        _ = NSApplication.shared
        let saved = NSApp.mainMenu
        AppDelegate().applicationWillFinishLaunching(Notification(name: NSApplication.willFinishLaunchingNotification))
        return saved
    }

    @MainActor func testEditMenuCarriesTheStandardEditingShortcuts() throws {
        let saved = installEditMenu()
        defer { NSApp.mainMenu = saved }

        let edit = try XCTUnwrap(NSApp.mainMenu?.items.compactMap(\.submenu).first { menu in
            menu.items.contains { $0.keyEquivalent == "c" }
        })
        let actions = Dictionary(uniqueKeysWithValues: edit.items
            .filter { !$0.keyEquivalent.isEmpty }
            .map { ($0.keyEquivalent, $0.action) })
        XCTAssertEqual(actions["x"], #selector(NSText.cut(_:)))
        XCTAssertEqual(actions["c"], #selector(NSText.copy(_:)))
        XCTAssertEqual(actions["v"], #selector(NSText.paste(_:)))
        XCTAssertEqual(actions["a"], #selector(NSText.selectAll(_:)))
        XCTAssertNil(actions["z"], "⌘Z stays with the toast's undo-completion shortcut")
    }

    @MainActor func testCommandCCopiesThroughTheMenuToTheFieldEditor() throws {
        let saved = installEditMenu()
        defer { NSApp.mainMenu = saved }

        let window = SidePanelWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 80),
                                     styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        defer { window.orderOut(nil) }
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = "HELLO WORLD"
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 80))
        container.addSubview(field)
        window.contentView = container
        window.makeKeyAndOrderFront(nil)
        XCTAssertTrue(window.makeFirstResponder(field))

        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("SENTINEL", forType: .string)
        for (keyCode, character) in [(UInt16(0), "a"), (UInt16(8), "c")] {
            let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command,
                                                       timestamp: ProcessInfo.processInfo.systemUptime,
                                                       windowNumber: window.windowNumber, context: nil,
                                                       characters: character, charactersIgnoringModifiers: character,
                                                       isARepeat: false, keyCode: keyCode))
            NSApp.sendEvent(event)
        }
        XCTAssertEqual(NSPasteboard.general.string(forType: .string), "HELLO WORLD")
    }
}
