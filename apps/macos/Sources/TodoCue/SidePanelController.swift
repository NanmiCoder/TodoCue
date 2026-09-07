import AppKit
import SwiftUI
import TodoCueKit

/// Borderless floating panel that accepts keyboard input.
final class SidePanelWindow: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class SidePanelController {
    let window: SidePanelWindow
    private let model: AppModel
    private var clickMonitor: Any?
    private var localClickMonitor: Any?
    private var observers: [NSObjectProtocol] = []
    var onShow: (() -> Void)?

    var isVisible: Bool { window.isVisible }

    init(model: AppModel) {
        self.model = model
        window = SidePanelWindow(contentRect: NSRect(x: 0, y: 0, width: Theme.panelWidth, height: Theme.panelHeight),
                                 styleMask: [.borderless, .fullSizeContentView], backing: .buffered, defer: false)
        window.isFloatingPanel = true
        window.becomesKeyOnlyIfNeeded = false
        window.hidesOnDeactivate = false
        window.level = .floating
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.isMovableByWindowBackground = true
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.isReleasedWhenClosed = false
        window.animationBehavior = .utilityWindow
        window.setAccessibilityLabel("TodoCue 任务面板")

        let root = PanelRootView().environmentObject(model)
        let hosting = NSHostingView(rootView: root)
        hosting.frame = window.contentView!.bounds
        hosting.autoresizingMask = [.width, .height]
        window.contentView = PanelBackgroundView(hosting: hosting)

        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.repositionIfVisible() }
        })
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.repositionIfVisible() }
        })
    }

    private func targetScreen() -> NSScreen {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
    }

    private func frame(on screen: NSScreen) -> NSRect {
        let vf = screen.visibleFrame
        let m = Theme.panelMargin
        let w = min(Theme.panelWidth, vf.width - 2 * m)
        let h = min(Theme.panelHeight, vf.height - 2 * m)
        let x = vf.maxX - m - w
        let y = vf.maxY - m - h
        return NSRect(x: x, y: y, width: w, height: h)
    }

    func show() {
        let wasVisible = window.isVisible
        if !wasVisible {
            window.setFrame(frame(on: targetScreen()), display: true)
            if Theme.reduceMotion {
                window.alphaValue = 1
                window.orderFrontRegardless()
            } else {
                window.alphaValue = 0
                let f = window.frame
                window.setFrame(f.offsetBy(dx: 12, dy: 0), display: false)
                window.orderFrontRegardless()
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = 0.26
                    ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                    window.animator().alphaValue = 1
                    window.animator().setFrame(f, display: true)
                }
            }
        }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        installClickMonitor()
        onShow?()
    }

    func hide() {
        guard window.isVisible else { return }
        removeClickMonitor()
        if Theme.reduceMotion {
            window.orderOut(nil)
        } else {
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.18
                ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
                window.animator().alphaValue = 0
            }, completionHandler: { [window] in
                window.orderOut(nil)
                window.alphaValue = 1
            })
        }
    }

    private func repositionIfVisible() {
        guard window.isVisible else { return }
        let screen = window.screen ?? targetScreen()
        var f = window.frame
        let target = frame(on: screen)
        // Keep the user's dragged position when possible, but clamp into the visible area.
        let vf = screen.visibleFrame
        if !vf.contains(f) {
            f.size.width = min(f.width, target.width)
            f.size.height = min(f.height, target.height)
            f.origin.x = min(max(f.minX, vf.minX + Theme.panelMargin), vf.maxX - Theme.panelMargin - f.width)
            f.origin.y = min(max(f.minY, vf.minY + Theme.panelMargin), vf.maxY - Theme.panelMargin - f.height)
            window.setFrame(f, display: true)
        }
    }

    private func installClickMonitor() {
        removeClickMonitor()
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            Task { @MainActor in self?.handleOutsideClick(NSEvent.mouseLocation) }
        }
        localClickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            if let self, event.window !== self.window {
                Task { @MainActor in self.handleOutsideClick(NSEvent.mouseLocation) }
            }
            return event
        }
    }

    private func handleOutsideClick(_ location: NSPoint) {
        guard window.isVisible, !model.pinned else { return }
        if !window.frame.contains(location) { hide() }
    }

    private func removeClickMonitor() {
        if let m = clickMonitor { NSEvent.removeMonitor(m); clickMonitor = nil }
        if let m = localClickMonitor { NSEvent.removeMonitor(m); localClickMonitor = nil }
    }
}

/// Frosted background with rounded corners, thin edge and soft shadow.
final class PanelBackgroundView: NSView {
    init(hosting: NSView) {
        super.init(frame: hosting.frame)
        wantsLayer = true
        layer?.masksToBounds = false

        let effect = NSVisualEffectView(frame: bounds)
        effect.autoresizingMask = [.width, .height]
        effect.material = Theme.reduceTransparency ? .windowBackground : .popover
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = Theme.panelCorner
        effect.layer?.cornerCurve = .continuous
        effect.layer?.masksToBounds = true
        effect.layer?.borderWidth = 0.5
        effect.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.6).cgColor
        addSubview(effect)

        hosting.frame = bounds
        hosting.autoresizingMask = [.width, .height]
        hosting.wantsLayer = true
        hosting.layer?.cornerRadius = Theme.panelCorner
        hosting.layer?.cornerCurve = .continuous
        hosting.layer?.masksToBounds = true
        addSubview(hosting)
    }

    required init?(coder: NSCoder) { nil }
}
