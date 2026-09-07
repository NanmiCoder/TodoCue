import AppKit
import SwiftUI
import Combine

/// Non-activating panel merged with the camera notch.
final class NotchWindow: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

struct NotchGeometry: Equatable {
    var screenFrame: NSRect
    var notchRect: NSRect   // in screen coordinates, the physical notch
    var notchHeight: CGFloat { notchRect.height }
}

/// Manages the notch quick-look: hover detection, expand/collapse and window placement.
@MainActor
final class NotchController {
    private let model: AppModel
    private var window: NotchWindow?
    private var hosting: NSHostingView<NotchRootView>?
    private let state = NotchState()
    private var geometry: NotchGeometry?
    private var globalMoveMonitor: Any?
    private var pollTimer: Timer?
    private var hoverStart: Date?
    private var leaveStart: Date?
    private var observers: [NSObjectProtocol] = []
    private var cancellables: Set<AnyCancellable> = []
    private var lastNotchScreen: NSScreen?

    private let hoverDelay: TimeInterval = 0.2
    private let leaveDelay: TimeInterval = 0.35
    private let hotZoneSlack: CGFloat = 10

    init(model: AppModel) {
        self.model = model
        state.onOpenTask = { [weak self] id in self?.model.reveal(taskId: id) }
        state.onOpenAll = { [weak self] in self?.model.openToday() }
        state.onContentSize = { [weak self] size in
            Task { @MainActor in self?.applyExpandedSize(size) }
        }
    }

    func start() {
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.rebuild() }
        })
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.collapse(immediately: true) }
        })
        NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.rebuild() }
        }
        rebuild()
    }

    func stop() {
        pollTimer?.invalidate()
        if let m = globalMoveMonitor { NSEvent.removeMonitor(m) }
        window?.orderOut(nil)
    }

    // MARK: - Geometry

    static func notchScreen() -> (NSScreen, NotchGeometry)? {
        for screen in NSScreen.screens {
            guard screen.safeAreaInsets.top > 0 else { continue }
            let f = screen.frame
            let h = screen.safeAreaInsets.top
            var left = f.minX + f.width * 0.5 - 90
            var right = f.minX + f.width * 0.5 + 90
            if let l = screen.auxiliaryTopLeftArea, let r = screen.auxiliaryTopRightArea {
                left = l.maxX; right = r.minX
            }
            let notch = NSRect(x: left, y: f.maxY - h, width: right - left, height: h)
            return (screen, NotchGeometry(screenFrame: f, notchRect: notch))
        }
        return nil
    }

    private func rebuild() {
        guard Prefs.isNotchEnabled, let (screen, geo) = Self.notchScreen() else {
            teardownWindow()
            return
        }
        lastNotchScreen = screen
        if geometry != geo || window == nil {
            geometry = geo
            ensureWindow()
            state.notchWidth = geo.notchRect.width
            state.notchHeight = geo.notchHeight
            if state.expanded { applyExpandedSize(state.contentSize) } else { placeCollapsed() }
        }
        ensureMonitors()
    }

    private func teardownWindow() {
        window?.orderOut(nil)
        window = nil
        geometry = nil
        pollTimer?.invalidate(); pollTimer = nil
        if let m = globalMoveMonitor { NSEvent.removeMonitor(m); globalMoveMonitor = nil }
    }

    private func ensureWindow() {
        if window != nil { return }
        let w = NotchWindow(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        w.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        w.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        w.isOpaque = false
        w.backgroundColor = .clear
        w.hasShadow = false
        w.ignoresMouseEvents = false
        w.hidesOnDeactivate = false
        w.isReleasedWhenClosed = false
        w.isMovable = false
        w.setAccessibilityLabel("TodoCue 刘海快览")
        let h = NSHostingView(rootView: NotchRootView(state: state, model: model))
        h.autoresizingMask = [.width, .height]
        w.contentView = h
        hosting = h
        window = w
        placeCollapsed()
        w.orderFrontRegardless()
    }

    private func collapsedFrame() -> NSRect {
        guard let geo = geometry else { return .zero }
        let n = geo.notchRect
        return NSRect(x: n.minX - hotZoneSlack, y: n.minY, width: n.width + 2 * hotZoneSlack, height: n.height)
    }

    private func expandedFrame(contentSize: CGSize) -> NSRect {
        guard let geo = geometry else { return .zero }
        let n = geo.notchRect
        let width = max(Theme.notchExpandedWidth, n.width + 2 * hotZoneSlack)
        let height = min(Theme.notchMaxHeight, max(contentSize.height, 40)) + n.height
        let cx = n.midX
        return NSRect(x: cx - width / 2, y: geo.screenFrame.maxY - height, width: width, height: height)
    }

    private func placeCollapsed() {
        window?.setFrame(collapsedFrame(), display: true)
    }

    private func applyExpandedSize(_ size: CGSize) {
        guard state.expanded, let window else { return }
        let target = expandedFrame(contentSize: size)
        if window.frame != target {
            window.setFrame(target, display: true)
        }
    }

    // MARK: - Hover detection

    private func ensureMonitors() {
        if globalMoveMonitor == nil {
            globalMoveMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { [weak self] _ in
                Task { @MainActor in self?.mouseMoved() }
            }
        }
    }

    private func mouseMoved() {
        guard geometry != nil else { return }
        let loc = NSEvent.mouseLocation
        if isNearTop(loc) && pollTimer == nil {
            startPolling()
        }
    }

    private func isNearTop(_ p: NSPoint) -> Bool {
        guard let geo = geometry else { return false }
        return p.y > geo.screenFrame.maxY - geo.notchHeight - 40 && geo.screenFrame.contains(NSPoint(x: p.x, y: min(p.y, geo.screenFrame.maxY - 1)))
    }

    private func startPolling() {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
        RunLoop.main.add(pollTimer!, forMode: .common)
    }

    private func poll() {
        guard let window else { pollTimer?.invalidate(); pollTimer = nil; return }
        let loc = NSEvent.mouseLocation
        let inHot = collapsedFrame().contains(loc)
        let inPanel = state.expanded && window.frame.contains(loc)
        let inside = inHot || inPanel
        let now = Date()

        if !state.expanded {
            if inHot {
                if hoverStart == nil { hoverStart = now }
                if now.timeIntervalSince(hoverStart!) >= hoverDelay {
                    if shouldAutoExpand() { expand() }
                }
            } else {
                hoverStart = nil
                if !isNearTop(loc) { pollTimer?.invalidate(); pollTimer = nil }
            }
        } else {
            if inside {
                leaveStart = nil
            } else {
                if leaveStart == nil { leaveStart = now }
                if now.timeIntervalSince(leaveStart!) >= leaveDelay { collapse(immediately: false) }
            }
        }
    }

    /// Fullscreen heuristic: the frontmost app owns an on-screen window covering the whole notch screen.
    private func shouldAutoExpand() -> Bool {
        guard Prefs.disableNotchInFullscreen, let geo = geometry else { return true }
        guard let front = NSWorkspace.shared.frontmostApplication, front != NSRunningApplication.current else { return true }
        let pid = front.processIdentifier
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return true }
        for w in list {
            guard (w[kCGWindowOwnerPID as String] as? Int32) == pid,
                  let b = w[kCGWindowBounds as String] as? [String: CGFloat],
                  let width = b["Width"], let height = b["Height"] else { continue }
            if abs(width - geo.screenFrame.width) < 2 && abs(height - geo.screenFrame.height) < 2 { return false }
        }
        return true
    }

    private func expand() {
        guard let window, !state.expanded else { return }
        state.reduceMotion = Theme.reduceMotion
        state.expanded = true
        hoverStart = nil
        leaveStart = nil
        let size = state.contentSize == .zero ? CGSize(width: Theme.notchExpandedWidth, height: 180) : state.contentSize
        let target = expandedFrame(contentSize: size)
        if Theme.reduceMotion {
            window.setFrame(target, display: true)
        } else {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.26
                ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1.0)
                window.animator().setFrame(target, display: true)
            }
        }
    }

    func collapse(immediately: Bool) {
        guard let window, state.expanded else { return }
        state.expanded = false
        leaveStart = nil
        hoverStart = nil
        let target = collapsedFrame()
        if immediately || Theme.reduceMotion {
            window.setFrame(target, display: true)
        } else {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.18
                ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
                window.animator().setFrame(target, display: true)
            }
        }
    }
}
