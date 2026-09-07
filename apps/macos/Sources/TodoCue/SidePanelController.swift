import AppKit
import SwiftUI
import TodoCueKit

/// Borderless floating panel that accepts keyboard input.
final class SidePanelWindow: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class SidePanelController: NSObject, NSWindowDelegate {
    let window: SidePanelWindow
    private let model: AppModel
    private let defaults: UserDefaults
    private var presentationRevision = 0
    private var observers: [NSObjectProtocol] = []
    var onShow: (() -> Void)?

    var isVisible: Bool { window.isVisible }

    init(model: AppModel, defaults: UserDefaults = .standard) {
        self.model = model
        self.defaults = defaults
        window = SidePanelWindow(contentRect: NSRect(x: 0, y: 0, width: Prefs.panelWidth(in: defaults), height: Theme.panelHeight),
                                 styleMask: [.borderless, .resizable, .fullSizeContentView, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        window.delegate = self
        window.minSize = NSSize(width: Theme.panelMinWidth, height: Theme.panelHeight)
        window.maxSize = NSSize(width: Theme.panelMaxWidth, height: Theme.panelHeight)
        window.isFloatingPanel = true
        window.becomesKeyOnlyIfNeeded = true
        window.hidesOnDeactivate = false
        window.level = .floating
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.isMovableByWindowBackground = true
        window.isOpaque = false
        window.backgroundColor = .clear
        // Tahoe's window shadow adds a rectangular rim even to transparent,
        // borderless panels. Let the native glass define the visible perimeter.
        if #available(macOS 26.0, *) { window.hasShadow = false }
        else { window.hasShadow = true }
        window.isReleasedWhenClosed = false
        window.animationBehavior = .utilityWindow
        window.setAccessibilityLabel("TodoCue 任务面板")

        let root = PanelRootView().environmentObject(model)
        let hosting = NSHostingView(rootView: root)
        // The window proposes the width; long content must not impose an intrinsic minimum.
        hosting.sizingOptions = []
        hosting.frame = window.contentView!.bounds
        hosting.autoresizingMask = [.width, .height]
        let background = PanelBackgroundView(hosting: hosting)
        background.resizeHandle.onResize = { [weak self] width, finished in
            self?.resize(to: width, persist: finished)
        }
        window.contentView = background

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
        let w = PanelGeometry.width(Prefs.panelWidth(in: defaults), available: vf.width - 2 * m)
        let h = min(Theme.panelHeight, vf.height - 2 * m)
        let x = vf.maxX - m - w
        let y = vf.maxY - m - h
        return NSRect(x: x, y: y, width: w, height: h)
    }

    func resize(to width: CGFloat, persist: Bool = true) {
        let screen = window.screen ?? targetScreen()
        let resized = PanelGeometry.resized(window.frame, to: width, in: screen.visibleFrame)
        window.setFrame(resized, display: true)
        if persist { Prefs.savePanelWidth(resized.width, in: defaults) }
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        Prefs.savePanelWidth(window.frame.width, in: defaults)
        repositionIfVisible()
    }

    func windowDidResize(_ notification: Notification) {
        // SwiftUI lays out the field on the next pass; its active AppKit field editor
        // otherwise keeps the old text-container width until editing ends.
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  let editor = self.window.firstResponder as? NSTextView,
                  editor.isFieldEditor,
                  let field = editor.delegate as? NSTextField,
                  field.maximumNumberOfLines != 1,
                  field.cell?.usesSingleLineMode != true else { return }
            self.window.contentView?.layoutSubtreeIfNeeded()
            Self.synchronizeFieldEditor(editor)
        }
    }

    static func synchronizeFieldEditor(_ editor: NSTextView) {
        guard let container = editor.textContainer,
              abs(container.containerSize.width - editor.bounds.width) > 0.5 else { return }
        container.containerSize.width = editor.bounds.width
        editor.needsDisplay = true
    }

    private func updateSizeLimits(on screen: NSScreen) {
        let available = screen.visibleFrame.insetBy(dx: Theme.panelMargin, dy: Theme.panelMargin)
        let height = min(Theme.panelHeight, available.height)
        window.minSize = NSSize(width: min(Theme.panelMinWidth, available.width), height: height)
        window.maxSize = NSSize(width: min(Theme.panelMaxWidth, available.width), height: height)
    }

    func show(focusInput: Bool = false) {
        presentationRevision += 1
        window.alphaValue = 1
        let wasVisible = window.isVisible
        if !wasVisible {
            let screen = targetScreen()
            updateSizeLimits(on: screen)
            window.setFrame(frame(on: screen), display: true)
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
        // Revealing a glanceable utility must not activate TodoCue or take another
        // app's insertion point. Only an explicit editing action requests a key panel.
        if focusInput { window.makeKeyAndOrderFront(nil) }
        else { window.orderFrontRegardless() }
        onShow?()
    }

    func hide() {
        guard window.isVisible else { return }
        presentationRevision += 1
        let revision = presentationRevision
        if Theme.reduceMotion {
            window.orderOut(nil)
        } else {
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.18
                ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
                window.animator().alphaValue = 0
            }, completionHandler: { [weak self] in
                Task { @MainActor in
                    guard let self, self.presentationRevision == revision else { return }
                    self.window.orderOut(nil)
                    self.window.alphaValue = 1
                }
            })
        }
    }

    private func repositionIfVisible() {
        guard window.isVisible else { return }
        let screen = window.screen ?? targetScreen()
        updateSizeLimits(on: screen)
        // Keep the user's dragged position when possible, but clamp into the visible area.
        let fitted = PanelGeometry.fitted(window.frame, in: screen.visibleFrame)
        if fitted != window.frame {
            window.setFrame(fitted, display: true)
        }
    }

}

/// One native glass plane for the floating utility. Content uses quiet, readable fills.
final class PanelBackgroundView: NSView {
    let resizeHandle = PanelResizeHandle()
    private let foreground = NSView()
    private var fallbackEffect: NSVisualEffectView?
    private var accessibilityObserver: NSObjectProtocol?

    init(hosting: NSView) {
        super.init(frame: hosting.frame)
        wantsLayer = true
        foreground.frame = bounds
        foreground.autoresizingMask = [.width, .height]

        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView(frame: bounds)
            glass.style = .regular
            glass.cornerRadius = Theme.panelCorner
            glass.autoresizingMask = [.width, .height]
            glass.contentView = foreground
            addSubview(glass)
        } else {
            let effect = NSVisualEffectView(frame: bounds)
            effect.material = .popover
            effect.blendingMode = .behindWindow
            effect.state = .active
            effect.autoresizingMask = [.width, .height]
            effect.wantsLayer = true
            effect.layer?.cornerRadius = Theme.panelCorner
            effect.layer?.masksToBounds = true
            fallbackEffect = effect
            addSubview(effect)
            addSubview(foreground)
        }

        hosting.frame = foreground.bounds
        hosting.autoresizingMask = [.width, .height]
        hosting.wantsLayer = true
        hosting.layer?.cornerRadius = Theme.panelCorner
        hosting.layer?.cornerCurve = .continuous
        hosting.layer?.masksToBounds = true
        foreground.addSubview(hosting)
        foreground.addSubview(resizeHandle)
        updateMaterial()
        accessibilityObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.updateMaterial() }
        }
    }

    override func layout() {
        super.layout()
        resizeHandle.frame = NSRect(x: 0, y: Theme.panelCorner, width: 10, height: max(0, bounds.height - 2 * Theme.panelCorner))
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateMaterial()
    }

    private func updateMaterial() {
        // NSGlassEffectView handles system accessibility changes itself.
        guard let effect = fallbackEffect else { return }
        effectiveAppearance.performAsCurrentDrawingAppearance {
            effect.isHidden = Theme.reduceTransparency
            layer?.cornerRadius = Theme.panelCorner
            layer?.backgroundColor = Theme.reduceTransparency ? NSColor.windowBackgroundColor.cgColor : NSColor.clear.cgColor
        }
    }

    deinit {
        if let accessibilityObserver { NSWorkspace.shared.notificationCenter.removeObserver(accessibilityObserver) }
    }
    required init?(coder: NSCoder) { nil }
}
