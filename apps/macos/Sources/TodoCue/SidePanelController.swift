import AppKit
import SwiftUI
import Combine
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
    private var languageSubscription: AnyCancellable?
    var onShow: (() -> Void)?
    /// Only when the panel goes from hidden to visible, not when an open panel is re-shown.
    var onReveal: (() -> Void)?

    var isVisible: Bool { window.isVisible }

    init(model: AppModel, defaults: UserDefaults = .standard) {
        self.model = model
        self.defaults = defaults
        window = SidePanelWindow(contentRect: NSRect(x: 0, y: 0, width: Prefs.panelWidth(in: defaults), height: Prefs.panelHeight(in: defaults)),
                                 styleMask: [.borderless, .resizable, .fullSizeContentView, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        window.delegate = self
        window.minSize = NSSize(width: Theme.panelMinWidth, height: Theme.panelMinHeight)
        window.maxSize = NSSize(width: Theme.panelMaxWidth, height: Theme.panelMaxHeight)
        window.isFloatingPanel = true
        window.becomesKeyOnlyIfNeeded = true
        window.hidesOnDeactivate = false
        window.level = .floating
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        // Plain SwiftUI text fields can otherwise hand their selection drag to the window.
        // Window movement is explicit and confined to the header's drag area.
        window.isMovableByWindowBackground = false
        window.isOpaque = false
        window.backgroundColor = .clear
        // The window is only a carrier for separate tiles; a window shadow would outline the
        // whole rectangle, gaps included, so each tile stands on its own material instead.
        window.hasShadow = false
        window.isReleasedWhenClosed = false
        window.animationBehavior = .utilityWindow
        window.setAccessibilityLabel(L10n.tr("TodoCue 任务面板"))

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
        background.verticalResizeHandle.onResize = { [weak self] height, finished in
            self?.resizeHeight(to: height, persist: finished)
        }
        window.contentView = background
        languageSubscription = LanguagePreferences.shared.$language.sink { [weak self, weak background] _ in
            DispatchQueue.main.async {
                self?.window.setAccessibilityLabel(L10n.tr("TodoCue 任务面板"))
                background?.resizeHandle.updateLanguage()
                background?.verticalResizeHandle.updateLanguage()
            }
        }

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
        let h = PanelGeometry.height(Prefs.panelHeight(in: defaults), available: vf.height - 2 * m)
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

    func resizeHeight(to height: CGFloat, persist: Bool = true) {
        let screen = window.screen ?? targetScreen()
        let resized = PanelGeometry.resizedVertically(window.frame, to: height, in: screen.visibleFrame)
        window.setFrame(resized, display: true)
        if persist { Prefs.savePanelHeight(resized.height, in: defaults) }
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        Prefs.savePanelWidth(window.frame.width, in: defaults)
        Prefs.savePanelHeight(window.frame.height, in: defaults)
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
        window.minSize = NSSize(width: min(Theme.panelMinWidth, available.width), height: min(Theme.panelMinHeight, available.height))
        window.maxSize = NSSize(width: min(Theme.panelMaxWidth, available.width), height: min(Theme.panelMaxHeight, available.height))
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
                // Only fade: the tiles carry the movement (DialRevealModifier), on one axis.
                window.alphaValue = 0
                window.orderFrontRegardless()
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = 0.16
                    ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                    window.animator().alphaValue = 1
                }
            }
        }
        // Revealing a glanceable utility must not activate TodoCue or take another
        // app's insertion point. Only an explicit editing action requests a key panel.
        if !wasVisible { onReveal?() }
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

struct PanelDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> DragView { DragView() }
    func updateNSView(_ nsView: DragView, context: Context) {}

    final class DragView: NSView {
        override var mouseDownCanMoveWindow: Bool { false }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
    }
}

/// Transparent carrier for the Dial panel: SwiftUI draws the frosted shell and the tiles on it
/// (`DialShell`), so this view only clips to the shell's corner and holds the resize edges.
final class PanelBackgroundView: NSView {
    let resizeHandle = PanelResizeHandle()
    let verticalResizeHandle = PanelResizeHandle(vertical: true)

    init(hosting: NSView) {
        super.init(frame: hosting.frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        layer?.cornerRadius = Dial.shellRadius
        layer?.cornerCurve = .continuous
        layer?.masksToBounds = true
        hosting.frame = bounds
        hosting.autoresizingMask = [.width, .height]
        hosting.wantsLayer = true
        hosting.layer?.backgroundColor = NSColor.clear.cgColor
        addSubview(hosting)
        addSubview(resizeHandle)
        addSubview(verticalResizeHandle)
    }

    override func layout() {
        super.layout()
        verticalResizeHandle.frame = NSRect(x: Dial.shellRadius, y: 0, width: max(0, bounds.width - 2 * Dial.shellRadius), height: 10)
        resizeHandle.frame = NSRect(x: 0, y: Dial.shellRadius, width: 10, height: max(0, bounds.height - 2 * Dial.shellRadius))
    }

    required init?(coder: NSCoder) { nil }
}
