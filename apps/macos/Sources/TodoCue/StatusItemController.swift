import TodoCueKit
import AppKit
import Combine
import ServiceManagement

/// Menu bar entry: the only entry point on screens without a notch.
@MainActor
final class StatusItemController: NSObject, NSMenuDelegate {
    private let item: NSStatusItem
    private let model: AppModel
    private weak var appDelegate: AppDelegate?
    private var cancellables: Set<AnyCancellable> = []
    private let menu = NSMenu()

    init(model: AppModel, delegate: AppDelegate) {
        self.model = model
        self.appDelegate = delegate
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        if let b = item.button {
            b.image = Self.cueImage()
            b.imagePosition = .imageLeading
            b.setAccessibilityLabel(L10n.tr("TodoCue 任务"))
        }
        menu.delegate = self
        item.menu = menu
        model.$today.map(\.remaining).removeDuplicates().sink { [weak self] n in self?.updateTitle(n) }.store(in: &cancellables)
        model.$connectionState.sink { [weak self] _ in self?.updateTitle(model.remaining) }.store(in: &cancellables)
        LanguagePreferences.shared.$language.sink { [weak self] _ in
            DispatchQueue.main.async { self?.updateTitle(model.remaining) }
        }.store(in: &cancellables)
        updateTitle(0)
    }

    private static func cueImage() -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            NSColor.black.setStroke()
            let ring = NSBezierPath()
            ring.appendArc(withCenter: NSPoint(x: 8, y: 9), radius: 6, startAngle: 38, endAngle: 322)
            ring.lineWidth = 1.7
            ring.lineCapStyle = .round
            ring.stroke()
            NSColor.black.setFill()
            NSBezierPath(ovalIn: NSRect(x: 13, y: 7.3, width: 3.4, height: 3.4)).fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "TodoCue"
        return image
    }

    private func updateTitle(_ n: Int) {
        guard let b = item.button else { return }
        b.setAccessibilityLabel(L10n.tr("TodoCue 任务"))
        b.title = n > 0 ? " \(n)" : ""
        b.appearsDisabled = !model.connectionState.isOnline
        b.toolTip = model.connectionState.isOnline ? L10n.tr("今日剩余 \(n) 项") : "TodoCue · \(model.connectionState.label)"
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.addItem(withTitle: L10n.tr("打开面板"), action: #selector(openPanel), keyEquivalent: "").target = self
        let remaining = NSMenuItem(title: L10n.tr("今日剩余 \(model.remaining) 项"), action: nil, keyEquivalent: "")
        remaining.isEnabled = false
        menu.addItem(remaining)
        if let n = model.next?.next {
            let nx = NSMenuItem(title: L10n.tr("下一项：\(n.task.title)"), action: #selector(openNext), keyEquivalent: "")
            nx.target = self
            nx.representedObject = n.task.id
            menu.addItem(nx)
        }
        if !model.connectionState.isOnline {
            let off = NSMenuItem(title: model.connectionState.label, action: nil, keyEquivalent: "")
            off.isEnabled = false
            menu.addItem(off)
        }
        menu.addItem(.separator())
        let add = NSMenuItem(title: L10n.tr("新建任务"), action: #selector(newTask), keyEquivalent: "n")
        add.target = self
        add.isEnabled = model.canWrite
        menu.addItem(add)
        menu.addItem(withTitle: L10n.tr("重新连接"), action: #selector(reconnect), keyEquivalent: "").target = self
        menu.addItem(withTitle: L10n.tr("设置…"), action: #selector(openSettings), keyEquivalent: ",").target = self
        if #available(macOS 13.0, *) {
            let login = NSMenuItem(title: L10n.tr("登录时启动"), action: #selector(toggleLogin), keyEquivalent: "")
            login.target = self
            login.state = SMAppService.mainApp.status == .enabled ? .on : .off
            menu.addItem(login)
        }
        menu.addItem(.separator())
        menu.addItem(withTitle: L10n.tr("退出 TodoCue"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    @objc private func openPanel() { model.openToday() }
    @objc private func openNext(_ sender: NSMenuItem) {
        if let id = sender.representedObject as? String { model.reveal(taskId: id) }
    }
    @objc private func newTask() { model.newTask() }
    @objc private func reconnect() { model.reconnect() }
    @objc private func openSettings() { model.showSettings() }
    @objc private func toggleLogin() {
        guard #available(macOS 13.0, *) else { return }
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch {
            model.showToast(Toast(message: L10n.tr("登录项设置失败：\(error.localizedDescription)"), isError: true))
        }
    }
}
