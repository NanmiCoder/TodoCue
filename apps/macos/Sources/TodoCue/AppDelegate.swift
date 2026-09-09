import AppKit
import ServiceManagement
import TodoCueKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel.shared
    private var statusItem: StatusItemController!
    private var sidePanel: SidePanelController!
    private var notch: NotchController!
    private var keyMonitor: Any?

    func applicationWillFinishLaunching(_ notification: Notification) {
        installEditMenu()
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleURLEvent(_:reply:)),
                                                     forEventClass: AEEventClass(kInternetEventClass),
                                                     andEventID: AEEventID(kAEGetURL))
    }

    /// An accessory app shows no menu bar, but AppKit still dispatches the standard editing
    /// shortcuts through main-menu key equivalents: with no main menu the field editor never
    /// receives `copy:`/`paste:`, so ⌘C/⌘V/⌘X/⌘A just beep. Undo stays out on purpose —
    /// ⌘Z belongs to the toast's "undo completion" shortcut.
    private func installEditMenu() {
        let mainMenu = NSMenu()
        let editItem = NSMenuItem()
        let edit = NSMenu(title: L10n.tr("编辑"))
        edit.addItem(withTitle: L10n.tr("剪切"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: L10n.tr("拷贝"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: L10n.tr("粘贴"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(NSMenuItem.separator())
        edit.addItem(withTitle: L10n.tr("全选"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        mainMenu.addItem(editItem)
        NSApp.mainMenu = mainMenu
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        #if DEBUG
        // Per-process preview only; never changes the user's system appearance.
        switch ProcessInfo.processInfo.environment["TODOCUE_PREVIEW_APPEARANCE"] {
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        default: break
        }
        #endif
        sidePanel = SidePanelController(model: model)
        notch = NotchController(model: model)
        statusItem = StatusItemController(model: model, delegate: self)

        model.onOpenPanel = { [weak self] focusInput in self?.sidePanel.show(focusInput: focusInput) }
        model.onClosePanel = { [weak self] in self?.sidePanel.hide() }
        model.onCollapseNotch = { [weak self] in self?.notch.collapse(immediately: true) }
        sidePanel.onShow = { [weak self] in self?.notch.collapse(immediately: true) }
        notch.isPanelVisible = { [weak self] in self?.sidePanel.isVisible ?? false }

        HotKeyCenter.shared.handler = { [weak self] in self?.togglePanel() }
        installKeyMonitor()
        model.start()
        notch.start()

        let background = CommandLine.arguments.contains("--background") || isLoginItemLaunch()
        if !background {
            sidePanel.show()
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        sidePanel.show()
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        notch.stop()
    }

    /// True when launchd started us as a login item (the launch Apple event carries `keyAELaunchedAsLogInItem`).
    private func isLoginItemLaunch() -> Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent else { return false }
        let key = AEKeyword(0x6C676974) // 'lgit' = keyAELaunchedAsLogInItem
        return event.paramDescriptor(forKeyword: key)?.booleanValue ?? false
    }

    func togglePanel() {
        if sidePanel.isVisible { sidePanel.hide() } else { sidePanel.show() }
    }

    // MARK: - URL scheme todocue://task/<id>

    @objc private func handleURLEvent(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let s = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
              let url = URL(string: s) else { return }
        handle(url: url)
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        urls.forEach(handle(url:))
    }

    private func handle(url: URL) {
        guard url.scheme == "todocue" else { return }
        if url.host == "task", let id = url.pathComponents.dropFirst().first, !id.isEmpty {
            model.reveal(taskId: id)
        } else {
            sidePanel.show()
        }
    }

    // MARK: - Keyboard

    private func installKeyMonitor() {
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.sidePanel.window.isKeyWindow else { return event }
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if event.keyCode == 53, flags.isEmpty { // Esc
                self.model.handleEscape()
                return nil
            }
            if flags == [.command, .shift], event.charactersIgnoringModifiers?.lowercased() == "k" {
                self.model.showCalendar()
                return nil
            }
            guard flags == .command, let ch = event.charactersIgnoringModifiers?.lowercased() else { return event }
            switch ch {
            case "n": self.model.newTask(); return nil
            case "f": self.model.focusQuickAdd(); return nil
            case "r": Task { await self.model.refreshAll() }; return nil
            case ",": self.model.showSettings(); return nil
            case "w": self.model.handleEscape(); return nil
            default: return event
            }
        }
    }
}
