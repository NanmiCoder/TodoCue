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
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleURLEvent(_:reply:)),
                                                     forEventClass: AEEventClass(kInternetEventClass),
                                                     andEventID: AEEventID(kAEGetURL))
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        sidePanel = SidePanelController(model: model)
        notch = NotchController(model: model)
        statusItem = StatusItemController(model: model, delegate: self)

        model.onOpenPanel = { [weak self] in self?.sidePanel.show() }
        model.onClosePanel = { [weak self] in self?.sidePanel.hide() }
        model.onCollapseNotch = { [weak self] in self?.notch.collapse(immediately: true) }
        sidePanel.onShow = { [weak self] in self?.notch.collapse(immediately: true) }

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
            guard flags == .command, let ch = event.charactersIgnoringModifiers?.lowercased() else { return event }
            switch ch {
            case "n": self.model.newTask(); return nil
            case "f": self.model.routes = []; self.model.quickAddFocusRequest += 1; return nil
            case "r": Task { await self.model.refreshAll() }; return nil
            case ",": self.model.showSettings(); return nil
            case "w": self.model.handleEscape(); return nil
            default: return event
            }
        }
    }
}
