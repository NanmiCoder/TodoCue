import AppKit
import SwiftUI
import Combine

/// Non-activating panel merged with the camera notch. It may become key only while expanded, so the
/// quick-add field can take typing without activating TodoCue or stealing focus while collapsed.
final class NotchWindow: NSPanel {
    var allowsKey = false
    override var canBecomeKey: Bool { allowsKey }
    override var canBecomeMain: Bool { false }
}

/// Hosting view that reacts to the first click even while the panel is not key, and reports the
/// pointer entering its bounds. The notch sits in the menu bar, where global mouse-moved monitors
/// are not delivered, so the tracking area is what reliably starts hover detection.
final class NotchHostingView<Content: View>: NSHostingView<Content> {
    var onPointerEntered: (() -> Void)?
    private var tracking: NSTrackingArea?

    required init(rootView: Content) { super.init(rootView: rootView) }
    required init?(coder: NSCoder) { nil }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) {
        super.mouseEntered(with: event)
        onPointerEntered?()
    }
}

struct NotchGeometry: Equatable {
    var screenFrame: NSRect
    var notchRect: NSRect   // in screen coordinates, the physical notch
    var notchHeight: CGFloat { notchRect.height }
}

/// Manages the notch quick-look: hover and click detection, expand/collapse, pinning and window placement.
@MainActor
final class NotchController {
    private let model: AppModel
    private var window: NotchWindow?
    private let state = NotchState()
    private var geometry: NotchGeometry?
    private var eventMonitors: [Any] = []
    private var pollTimer: Timer?
    private var hoverStart: Date?
    private var leaveStart: Date?
    /// After an explicit collapse the pointer must leave the bar before hovering can reopen it.
    private var rearmAfterLeave = false
    private var targetFrame: NSRect?
    private var observers: [NSObjectProtocol] = []
    private var cancellables: Set<AnyCancellable> = []
    private var cueQueue = ReminderCueQueue()
    private var cueTimer: Timer?
    private var cueDeadline = Date.distantPast
    private var nextCueTask: Task<Void, Never>?
    var activeCue: ReminderCue? { state.cue }
    var isPanelVisible: (() -> Bool)?

    private let hoverDelay: TimeInterval = 0.2
    private let leaveDelay: TimeInterval = 0.35

    init(model: AppModel) {
        self.model = model
        model.onReminderCue = { [weak self] cue in self?.receiveCue(cue) }
        state.onCueDismiss = { [weak self] in self?.dismissCue() }
        state.onCueOpen = { [weak self] in
            guard let self, let cue = self.state.cue else { return }
            self.dismissCue(showNext: false)
            self.model.reveal(taskId: cue.task.id)
        }
        state.onCueComplete = { [weak self] in self?.actOnCue(snooze: false) }
        state.onCueSnooze = { [weak self] in self?.actOnCue(snooze: true) }
        state.onCueSize = { [weak self] size in
            Task { @MainActor in self?.sizeCue(height: size.height) }
        }
        state.onOpenTask = { [weak self] id in self?.model.reveal(taskId: id) }
        state.onOpenAll = { [weak self] in self?.model.openToday() }
        state.onNewTask = { [weak self] in self?.model.newTask() }
        state.onTogglePin = { [weak self] in self?.togglePin() }
        state.onCollapse = { [weak self] in self?.collapse(immediately: false) }
        state.onEditingChanged = { [weak self] editing in self?.editingChanged(editing) }
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
        observers.append(NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.rebuild() }
        })
        // `@Published` emits before the property changes: read the values from the stream, not the model.
        Publishers.CombineLatest(model.$today.map(\.remaining), model.$connectionState.map(\.isOnline))
            .removeDuplicates { $0 == $1 }
            .sink { [weak self] remaining, online in self?.updateWings(remaining: remaining, online: online, animated: true) }
            .store(in: &cancellables)
        rebuild()
    }

    func stop() {
        nextCueTask?.cancel()
        cueTimer?.invalidate()
        cueQueue.clear()
        stopPolling()
        removeMonitors()
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
        guard Prefs.isNotchEnabled, let (_, geo) = Self.notchScreen() else {
            teardownWindow()
            return
        }
        let changed = geometry != geo
        geometry = geo
        state.notchWidth = geo.notchRect.width
        state.notchHeight = geo.notchHeight
        state.slack = Theme.notchSlack
        updateWings(remaining: model.remaining, online: model.connectionState.isOnline, animated: false)
        if window == nil {
            ensureWindow()
        } else if changed && (state.expanded || state.cue != nil) {
            collapse(immediately: true)
        } else {
            placeCollapsed(animated: false)
        }
        ensureMonitors()
    }

    private func teardownWindow() {
        nextCueTask?.cancel()
        cueTimer?.invalidate()
        cueQueue.clear()
        state.cue = nil
        window?.orderOut(nil)
        window = nil
        geometry = nil
        stopPolling()
        removeMonitors()
        state.expanded = false
        state.pinned = false
        state.editing = false
        hoverStart = nil
        leaveStart = nil
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
        w.becomesKeyOnlyIfNeeded = true
        w.animationBehavior = .none
        w.appearance = NSAppearance(named: .darkAqua)
        w.setAccessibilityLabel("TodoCue 刘海快览")
        let h = NotchHostingView(rootView: NotchRootView(state: state, model: model))
        // The window frame is derived from the measured card; the hosting view must not size the window.
        h.sizingOptions = []
        h.onPointerEntered = { [weak self] in self?.pointerEntered() }
        h.autoresizingMask = [.width, .height]
        w.contentView = h
        window = w
        placeCollapsed(animated: false)
        w.orderFrontRegardless()
    }

    private func collapsedFrame() -> NSRect {
        guard let geo = geometry else { return .zero }
        return NotchLayout.collapsedFrame(notch: geo.notchRect, slack: Theme.notchSlack, wing: state.wingWidth)
    }

    private func expandedFrame(contentHeight: CGFloat) -> NSRect {
        guard let geo = geometry else { return .zero }
        return NotchLayout.expandedFrame(notch: geo.notchRect, screen: geo.screenFrame,
                                         contentHeight: contentHeight > 0 ? contentHeight : 220,
                                         width: Theme.notchExpandedWidth, maxHeight: Theme.notchMaxHeight)
    }

    private func placeCollapsed(animated: Bool) {
        guard let window, !state.expanded, state.cue == nil else { return }
        let target = collapsedFrame()
        guard window.frame != target || targetFrame != target else { return }
        place(window, at: target, duration: animated ? 0.2 : 0)
    }

    private func applyExpandedSize(_ size: CGSize) {
        guard state.expanded, let window else { return }
        let target = expandedFrame(contentHeight: size.height)
        guard window.frame != target || targetFrame != target else { return }
        place(window, at: target, duration: 0.16)
    }

    /// Every placement goes through here so an animation that finishes late cannot undo a newer target
    /// (wing changes during startup and expand/collapse can overlap).
    private func place(_ window: NSWindow, at frame: NSRect, duration: TimeInterval, timing: CAMediaTimingFunction? = nil) {
        targetFrame = frame
        guard duration > 0, !Theme.reduceMotion else {
            window.setFrame(frame, display: true)
            return
        }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = duration
            ctx.timingFunction = timing ?? CAMediaTimingFunction(name: .easeOut)
            window.animator().setFrame(frame, display: true)
        }, completionHandler: { [weak self, weak window] in
            Task { @MainActor in
                guard let self, let window, let target = self.targetFrame, window.frame != target else { return }
                window.setFrame(target, display: true)
            }
        })
    }

    /// Wings show today's remaining count beside the notch; they fold away when the day is clear.
    private func updateWings(remaining: Int, online: Bool, animated: Bool) {
        let wing: CGFloat = Prefs.notchShowsSummary && (remaining > 0 || !online) ? Theme.notchWingWidth : 0
        guard wing != state.wingWidth else { return }
        state.wingWidth = wing
        placeCollapsed(animated: animated)
    }

    // MARK: - Pointer, click and keyboard monitors

    private func ensureMonitors() {
        guard eventMonitors.isEmpty else { return }
        let monitors: [Any?] = [
            NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { [weak self] event in
                self?.mouseMoved()
                return event
            },
            NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { [weak self] _ in
                Task { @MainActor in self?.mouseMoved() }
            },
            NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
                self?.localMouseDown(event) ?? event
            },
            NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                Task { @MainActor in self?.outsideMouseDown() }
            },
            NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                self?.keyDown(event) ?? event
            },
        ]
        eventMonitors = monitors.compactMap { $0 }
    }

    private func removeMonitors() {
        for m in eventMonitors { NSEvent.removeMonitor(m) }
        eventMonitors.removeAll()
    }

    private func pointerEntered() {
        guard geometry != nil, pollTimer == nil else { return }
        if !state.expanded || (!state.pinned && !state.editing) { startPolling() }
    }

    private func mouseMoved() {
        guard geometry != nil, pollTimer == nil else { return }
        if state.expanded {
            if !state.pinned && !state.editing { startPolling() }
        } else if isNearTop(NSEvent.mouseLocation) {
            startPolling()
        }
    }

    /// A click on the collapsed bar opens and pins the card. While the card is only hovered open, a click
    /// on the notch band pins it and takes the keyboard; a click elsewhere in the card just pins it so it
    /// survives the pointer leaving. A click in another TodoCue window closes it.
    private func localMouseDown(_ event: NSEvent) -> NSEvent? {
        guard let window else { return event }
        if state.cue != nil {
            if event.window !== window { dismissCue() }
            return event
        }
        if event.window === window {
            if !state.expanded {
                expand(pinned: true)
                return nil
            }
            if !state.pinned {
                let inNotchBand = event.locationInWindow.y >= window.frame.height - (geometry?.notchHeight ?? 0)
                pin(focusInput: inNotchBand)
                if inNotchBand { return nil }
            }
            return event
        }
        if state.expanded { collapse(immediately: false) }
        return event
    }

    private func outsideMouseDown() {
        if state.cue != nil { dismissCue(); return }
        if state.expanded { collapse(immediately: false) }
    }

    private func keyDown(_ event: NSEvent) -> NSEvent? {
        guard let window, state.expanded, window.isKeyWindow else { return event }
        if event.keyCode == 53 { // Esc: clear a draft first, then close.
            if !state.quickAddText.isEmpty { state.quickAddText = "" } else { collapse(immediately: false) }
            return nil
        }
        return event
    }

    private func isNearTop(_ p: NSPoint) -> Bool {
        guard let geo = geometry else { return false }
        return p.y > geo.screenFrame.maxY - geo.notchHeight - 40
            && geo.screenFrame.contains(NSPoint(x: p.x, y: min(p.y, geo.screenFrame.maxY - 1)))
    }

    private func startPolling() {
        pollTimer?.invalidate()
        let timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func poll() {
        guard state.cue == nil else { stopPolling(); return }
        guard let window else { stopPolling(); return }
        let loc = NSEvent.mouseLocation
        let inHot = collapsedFrame().contains(loc)
        let now = Date()

        if !state.expanded {
            if inHot {
                guard !rearmAfterLeave else { return }
                if hoverStart == nil { hoverStart = now }
                if now.timeIntervalSince(hoverStart!) >= hoverDelay, shouldAutoExpand() { expand(pinned: false) }
            } else {
                rearmAfterLeave = false
                hoverStart = nil
                if !isNearTop(loc) { stopPolling() }
            }
        } else if state.pinned || state.editing {
            leaveStart = nil
            stopPolling()
        } else if window.frame.contains(loc) || inHot {
            leaveStart = nil
        } else {
            if leaveStart == nil { leaveStart = now }
            if now.timeIntervalSince(leaveStart!) >= leaveDelay { collapse(immediately: false) }
        }
    }

    /// Fullscreen heuristic: the frontmost app owns an on-screen window covering the whole notch screen.
    private func shouldAutoExpand(forReminder: Bool = false) -> Bool {
        guard forReminder || isPanelVisible?() != true else { return false }
        guard Prefs.disableNotchInFullscreen, let geo = geometry else { return true }
        guard let front = NSWorkspace.shared.frontmostApplication, front != NSRunningApplication.current else { return true }
        let pid = front.processIdentifier
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return true }
        for w in list {
            guard (w[kCGWindowOwnerPID as String] as? Int32) == pid,
                  let b = w[kCGWindowBounds as String] as? [String: CGFloat],
                  let width = b["Width"], let height = b["Height"], let x = b["X"], let y = b["Y"] else { continue }
            // WindowServer uses a top-left origin on the primary display; AppKit uses bottom-left.
            let primaryTop = NSScreen.screens.first?.frame.maxY ?? geo.screenFrame.maxY
            let frame = CGRect(x: x, y: primaryTop - y - height, width: width, height: height)
            if NotchLayout.coversScreen(frame, screen: geo.screenFrame, topInset: geo.notchHeight) { return false }
        }
        return true
    }

    // MARK: - Expand / collapse

    private func expand(pinned: Bool) {
        guard state.cue == nil else { return }
        guard let window, geometry != nil else { return }
        if state.expanded {
            if pinned { pin(focusInput: true) }
            return
        }
        state.reduceMotion = Theme.reduceMotion
        state.pinned = pinned
        state.expanded = true
        window.allowsKey = true
        window.hasShadow = true
        hoverStart = nil
        leaveStart = nil
        place(window, at: expandedFrame(contentHeight: state.contentSize.height), duration: 0.28,
              timing: CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1.0))
        if pinned {
            pin(focusInput: true)
        } else if pollTimer == nil {
            startPolling()
        }
    }

    /// Keeps the card open until Esc or a click outside; opened on purpose, it also takes the keyboard
    /// so a task can be typed right away.
    private func pin(focusInput: Bool) {
        guard let window, state.expanded else { return }
        state.pinned = true
        stopPolling()
        if focusInput {
            window.makeKeyAndOrderFront(nil)
            state.focusRequest += 1
        }
    }

    func collapse(immediately: Bool) {
        if state.cue != nil { dismissCue(showNext: false); return }
        guard let window, state.expanded else { return }
        let wasKey = window.isKeyWindow
        state.expanded = false
        state.pinned = false
        state.editing = false
        window.allowsKey = false
        window.hasShadow = false
        hoverStart = nil
        leaveStart = nil
        rearmAfterLeave = collapsedFrame().contains(NSEvent.mouseLocation)
        let target = collapsedFrame()
        if wasKey {
            // A non-activating panel hands the keyboard back to the previous app when it is hidden;
            // re-showing the collapsed bar afterwards does not take it again.
            window.makeFirstResponder(nil)
            window.orderOut(nil)
            place(window, at: target, duration: 0)
            window.orderFrontRegardless()
        } else {
            place(window, at: target, duration: immediately ? 0 : 0.2, timing: CAMediaTimingFunction(name: .easeIn))
        }
        if pollTimer == nil, isNearTop(NSEvent.mouseLocation) { startPolling() }
        scheduleNextCue()
    }

    // MARK: - Reminder Cue: transient, actionable, and never takes the keyboard.

    func receiveCue(_ cue: ReminderCue) {
        guard Prefs.isNotchEnabled, geometry != nil, shouldAutoExpand(forReminder: true) else { return }
        cueQueue.append(cue)
        presentNextCue()
    }

    private func presentNextCue() {
        guard state.cue == nil, !state.expanded, let window, Prefs.isNotchEnabled,
              geometry != nil, shouldAutoExpand(forReminder: true) else { return }
        while let cue = cueQueue.next() {
            if let task = model.task(cue.task.id), task.status != .todo || task.reminderAt != cue.task.reminderAt { continue }
            stopPolling()
            state.reduceMotion = Theme.reduceMotion
            state.cueHovered = false
            state.cueError = nil
            state.cueBusy = false
            state.cue = cue
            window.allowsKey = false
            window.hasShadow = false
            window.orderFrontRegardless()
            sizeCue(height: 160)
            cueDeadline = Date().addingTimeInterval(9)
            cueTimer?.invalidate()
            let timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.tickCue() }
            }
            RunLoop.main.add(timer, forMode: .common)
            cueTimer = timer
            NSAccessibility.post(element: window, notification: .announcementRequested,
                                 userInfo: [.announcement: "TodoCue 提醒：\(cue.task.title)", .priority: NSAccessibilityPriorityLevel.medium.rawValue])
            return
        }
    }

    private func sizeCue(height: CGFloat) {
        guard state.cue != nil, let window, let geo = geometry else { return }
        let frame = NotchLayout.expandedFrame(notch: geo.notchRect, screen: geo.screenFrame,
                                              contentHeight: height, width: 460, maxHeight: 320)
        guard targetFrame != frame else { return }
        place(window, at: frame, duration: 0.28, timing: CAMediaTimingFunction(controlPoints: 0.18, 0.85, 0.25, 1))
    }

    private func tickCue() {
        guard let cue = state.cue else { return }
        if let task = model.task(cue.task.id), task.status != .todo || task.reminderAt != cue.task.reminderAt {
            if !state.cueBusy { dismissCue() }
            return
        }
        if state.cueHovered || state.cueBusy { cueDeadline = Date().addingTimeInterval(9) }
        if Date() >= cueDeadline { dismissCue() }
    }

    private func dismissCue(showNext: Bool = true) {
        cueTimer?.invalidate()
        cueTimer = nil
        state.cue = nil
        state.cueHovered = false
        state.cueBusy = false
        state.cueError = nil
        rearmAfterLeave = true
        placeCollapsed(animated: true)
        if showNext { scheduleNextCue() } else { cueQueue.clear(); nextCueTask?.cancel() }
    }

    private func scheduleNextCue() {
        nextCueTask?.cancel()
        nextCueTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            self?.presentNextCue()
        }
    }

    private func actOnCue(snooze: Bool) {
        guard let cue = state.cue, !state.cueBusy else { return }
        state.cueBusy = true
        Task {
            let success = await model.actOnCue(cue, snooze: snooze)
            guard state.cue?.id == cue.id else { return }
            state.cueBusy = false
            if success { dismissCue() }
            else { state.cueError = model.toast?.message ?? "暂时没能保存，请重试"; cueDeadline = Date().addingTimeInterval(12) }
        }
    }

    private func togglePin() {
        guard state.expanded else { return }
        state.pinned.toggle()
        if state.pinned { stopPolling() } else { startPolling() }
    }

    private func editingChanged(_ editing: Bool) {
        guard state.expanded, editing else { return }
        state.pinned = true
        stopPolling()
    }
}
