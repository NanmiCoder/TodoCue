import TodoCueKit
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
    var notchRect: NSRect   // in screen coordinates: the physical notch, or the drawn one
    var isVirtual = false
    var notchHeight: CGFloat { notchRect.height }
}

/// Manages the notch quick-look: hover and click detection, expand/collapse, pinning and window placement.
@MainActor
final class NotchController {
    private let model: AppModel
    private var window: NotchWindow?
    let state = NotchState()
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
    private var stack = CueStack()
    /// The user folded the stack into the wings. A new arrival, or a rule coming back into its window, unfolds it.
    private var collapsedByUser = false
    private var featuredUntil = Date.distantPast
    /// How long a new arrival is drawn as a full card before it rests as a row.
    var featureDuration: TimeInterval = 6
    private var deferred: [ReminderCue] = []
    private var periodicClaimInFlight = false
    private var stackTimer: Timer?
    private var stackLayoutTask: Task<Void, Never>?
    private var lastPulse = Date()
    private var otherScreenSince: Date?
    private var stackHeight: CGFloat = 120
    private var tickCount = 0
    /// The reminder in front: the newest arrival while it is featured, otherwise the first row.
    var activeCue: ReminderCue? {
        if let key = state.featuredKey, let entry = stack.entry(key) { return entry.cue }
        return stack.shown.first?.cue
    }
    var isPanelVisible: (() -> Bool)?

    private let hoverDelay: TimeInterval = 0.2
    private let leaveDelay: TimeInterval = 0.35

    init(model: AppModel) {
        self.model = model
        model.onReminderCue = { [weak self] cue in self?.receiveCue(cue) }
        model.onPeriodicCue = { [weak self] rule in self?.receivePeriodic(rule) }
        state.onCueOpen = { [weak self] key in self?.openCue(key) }
        state.onCueComplete = { [weak self] key in self?.answer(key, snooze: false) }
        state.onCueSnooze = { [weak self] key in self?.answer(key, snooze: true) }
        state.onCuePauseToday = { [weak self] key in self?.answer(key, pauseToday: true) }
        state.onStackCollapse = { [weak self] in self?.collapseStack() }
        state.onOpenQuickLook = { [weak self] in self?.openQuickLookFromStack() }
        state.onCueSize = { [weak self] size in
            Task { @MainActor in self?.sizeStack(height: size.height) }
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
        // Rows follow the rules: handled elsewhere they leave, and a rule that is still waiting after a
        // restart or reconnect comes back without a new event.
        model.$periodicReminders
            .sink { [weak self] rules in self?.syncPeriodic(rules) }
            .store(in: &cancellables)
        rebuild()
    }

    func stop() {
        stackLayoutTask?.cancel()
        stackTimer?.invalidate()
        stackTimer = nil
        stack.clear()
        deferred.removeAll()
        stopPolling()
        removeMonitors()
        window?.orderOut(nil)
    }

    // MARK: - Geometry

    /// The quick look follows the pointer: the screen under it hosts the notch, drawn in its menu bar
    /// when it has no camera housing. With drawn notches turned off, only a physical notch is used.
    static func notchScreen(at pointer: NSPoint = NSEvent.mouseLocation) -> (NSScreen, NotchGeometry)? {
        let allowVirtual = Prefs.notchOnDisplaysWithoutNotch
        if let screen = NSScreen.screens.first(where: { NSMouseInRect(pointer, $0.frame, false) }),
           let geo = geometry(of: screen, allowVirtual: allowVirtual) {
            return (screen, geo)
        }
        for screen in NSScreen.screens {
            if let geo = geometry(of: screen, allowVirtual: false) { return (screen, geo) }
        }
        return nil
    }

    private static func geometry(of screen: NSScreen, allowVirtual: Bool) -> NotchGeometry? {
        let f = screen.frame
        guard screen.safeAreaInsets.top > 0 else {
            guard allowVirtual else { return nil }
            return NotchGeometry(screenFrame: f, notchRect: NotchLayout.virtualNotch(screen: f, visible: screen.visibleFrame),
                                 isVirtual: true)
        }
        let h = screen.safeAreaInsets.top
        var left = f.minX + f.width * 0.5 - 90
        var right = f.minX + f.width * 0.5 + 90
        if let l = screen.auxiliaryTopLeftArea, let r = screen.auxiliaryTopRightArea {
            left = l.maxX; right = r.minX
        }
        let notch = NSRect(x: left, y: f.maxY - h, width: right - left, height: h)
        return NotchGeometry(screenFrame: f, notchRect: notch)
    }

    /// Moves the collapsed bar to the screen the pointer has crossed onto. An open card or the stack stays
    /// where it is, so it never jumps away from what you are reading; the stack moves after a dwell.
    private func followPointer() {
        guard let geo = geometry, !state.expanded, !state.stackShown,
              !NSMouseInRect(NSEvent.mouseLocation, geo.screenFrame, false) else { return }
        rebuild()
    }

    private func rebuild() {
        guard Prefs.isNotchEnabled, let (_, geo) = Self.notchScreen() else {
            teardownWindow()
            return
        }
        let changed = geometry != geo
        let becameAvailable = geometry == nil
        geometry = geo
        state.notchWidth = geo.notchRect.width
        state.notchHeight = geo.notchHeight
        state.slack = Theme.notchSlack
        updateWings(remaining: model.remaining, online: model.connectionState.isOnline, animated: false)
        if window == nil {
            ensureWindow()
        } else if changed && state.expanded {
            collapse(immediately: true)
        } else if state.stackShown {
            // The stack goes with the pointer or the new display layout; it is never dismissed for it.
            if changed {
                targetFrame = nil
                sizeStack(height: stackHeight)
            }
        } else {
            placeCollapsed(animated: false)
        }
        ensureMonitors()
        // Rules that were waiting before the notch had anywhere to show them come back now.
        if becameAvailable { syncPeriodic(model.periodicReminders) }
        layoutStack()
    }

    private func teardownWindow() {
        stackLayoutTask?.cancel()
        stackTimer?.invalidate()
        stackTimer = nil
        state.stackShown = false
        state.featuredKey = nil
        state.cueHovered = false
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
        w.setAccessibilityLabel(L10n.tr("TodoCue 刘海快览"))
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
        guard let window, !state.expanded, !state.stackShown else { return }
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
        // Wings also carry the count of reminders still waiting, even with the daily summary turned off.
        let summary = Prefs.notchShowsSummary && (remaining > 0 || !online)
        let wing: CGFloat = summary || !stack.isEmpty ? Theme.notchWingWidth : 0
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
        followPointer()
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
        if state.stackShown {
            // Reminders stay until answered: a click elsewhere never dismisses them. A click on the notch
            // band itself, which holds no control, opens the quick look.
            if event.window === window, event.locationInWindow.y >= window.frame.height - (geometry?.notchHeight ?? 0) {
                openQuickLookFromStack()
                return nil
            }
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
            && NSMouseInRect(p, geo.screenFrame, false)
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
        guard !state.stackShown else { stopPolling(); return }
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
        guard !state.stackShown else { return }
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
        scheduleStackLayout()
    }

    // MARK: - Reminders: a stack that stays until each one is answered.
    //
    // Nothing here completes, snoozes or pauses by itself. A row leaves when the user answers it, when
    // the runtime says it is no longer current, or (a rule) while it is outside its active windows.
    // Collapsing only folds the stack into the wings; the count stays visible there.

    func receiveCue(_ cue: ReminderCue) {
        guard Prefs.isNotchEnabled, geometry != nil else { return }
        admit(cue)
    }

    /// A new row does not take a place under a pointer that is on the stack: a click aimed at one row
    /// must not land on another. It waits, counted in the header, until the pointer leaves.
    private func admit(_ cue: ReminderCue) {
        if state.stackShown, state.cueHovered, stack.entry(cue.key) == nil {
            guard !deferred.contains(where: { $0.key == cue.key }) else { return }
            deferred.append(cue)
            state.deferredCount = deferred.count
            return
        }
        apply(cue)
    }

    private func apply(_ cue: ReminderCue) {
        guard stack.receive(cue) != .ignored else { return }
        collapsedByUser = false
        feature(cue.key)
        publishStack()
        // A reminder lands on the screen you are looking at, even if the stack is still on another one.
        if !state.expanded { rebuild() }
        layoutStack()
        if let window {
            NSAccessibility.post(element: window, notification: .announcementRequested,
                userInfo: [.announcement: L10n.tr("TodoCue 提醒：\(cue.title)"), .priority: NSAccessibilityPriorityLevel.medium.rawValue])
        }
    }

    private func feature(_ key: String) {
        state.featuredKey = key
        featuredUntil = Date().addingTimeInterval(featureDuration)
    }

    private func publishStack() {
        let shown = stack.shown
        if state.entries != shown { state.entries = shown }
        if let key = state.featuredKey, !shown.contains(where: { $0.key == key }) { state.featuredKey = nil }
        updateWings(remaining: model.remaining, online: model.connectionState.isOnline, animated: true)
        ensureStackTimer()
    }

    /// Periodic cards only claim when they can appear immediately on the pointer's screen: in the stack
    /// under the notch, or in the quick look if that is open there. They never wait in a queue.
    private func periodicScreenAvailable() -> Bool {
        guard Prefs.isNotchEnabled,
              let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }),
              Self.geometry(of: screen, allowVirtual: Prefs.notchOnDisplaysWithoutNotch) != nil else { return false }
        if !state.expanded { rebuild() }
        guard geometry?.screenFrame == screen.frame else { return false }
        return shouldAutoExpand(forReminder: true)
    }

    private func receivePeriodic(_ rule: PeriodicReminder) {
        guard !periodicClaimInFlight, let occurrence = rule.currentOccurrence,
              let offeredAt = occurrence.offeredAt.flatMap(TCDate.parse),
              Date().timeIntervalSince(offeredAt) >= -5, Date().timeIntervalSince(offeredAt) < 3,
              periodicScreenAvailable(), let client = model.client else { return }
        periodicClaimInFlight = true
        let token = UUID().uuidString
        Task { [weak self] in
            guard let self else { return }
            defer { self.periodicClaimInFlight = false }
            do {
                let claimed = try await client.claimPeriodic(rule.id, occurrenceId: occurrence.id, round: occurrence.round, token: token)
                guard self.model.mergePeriodic(claimed),
                      let claimedAt = claimed.currentOccurrence?.claimedAt.flatMap(TCDate.parse),
                      Date().timeIntervalSince(claimedAt) < 8,
                      self.periodicScreenAvailable(), self.window != nil else {
                    try? await client.periodicReceipt(rule.id, occurrenceId: occurrence.id, round: occurrence.round, token: token, displayed: false)
                    return
                }
                self.apply(ReminderCue(periodic: claimed))
                do {
                    try await client.periodicReceipt(rule.id, occurrenceId: occurrence.id, round: occurrence.round, token: token, displayed: true)
                } catch {
                    // A lost acknowledgement is safe to retry with the same claim token.
                    try? await client.periodicReceipt(rule.id, occurrenceId: occurrence.id, round: occurrence.round, token: token, displayed: true)
                }
            } catch {
                // If the claim response was lost, the runtime expires it without a second channel.
            }
        }
    }

    // MARK: Currency

    /// A rule keeps its row while one of its occurrences is open, whichever channel is delivering it.
    /// A snooze that has not come round yet is not open: it comes back as a new arrival.
    static func holdsPending(_ rule: PeriodicReminder) -> Bool {
        guard rule.enabled, rule.state != "paused_today", rule.state != "paused",
              let occurrence = rule.currentOccurrence, occurrence.result == "pending" else { return false }
        return ["offered", "claimed", "displayed", "submitted"].contains(occurrence.delivery)
    }

    private func isCurrent(_ entry: CueEntry) -> Bool {
        if let original = entry.cue.task {
            guard let task = model.task(original.id) else { return true }
            return task.status == .todo && task.reminderAt == original.reminderAt
        }
        if let original = entry.cue.periodic {
            guard let rule = model.periodicReminders.first(where: { $0.id == original.id }) else { return !model.periodicLoaded }
            return Self.holdsPending(rule)
        }
        return true
    }

    private func syncPeriodic(_ rules: [PeriodicReminder]) {
        let now = Date()
        var changed = false
        for entry in stack.entries {
            guard let original = entry.cue.periodic, let rule = rules.first(where: { $0.id == original.id }) else { continue }
            guard Self.holdsPending(rule) else {
                stack.remove(entry.key)
                changed = true
                continue
            }
            let fresh = ReminderCue(periodic: rule, now: now)
            if fresh.id == entry.cue.id {
                stack.refresh(entry.key, with: fresh)
            } else if ["claimed", "displayed", "submitted"].contains(rule.currentOccurrence?.delivery ?? ""),
                      stack.receive(fresh, now: now) == .merged {
                // Came round again before it was answered: same row, one more.
                collapsedByUser = false
                feature(entry.key)
                changed = true
            }
        }
        // A rule that is still waiting after a restart or a reconnect: it was shown, so it comes back.
        for rule in rules where stack.entry("periodic:\(rule.id)") == nil {
            guard Self.holdsPending(rule), rule.currentOccurrence?.delivery == "displayed", rule.isActive(at: now) else { continue }
            guard Prefs.isNotchEnabled, geometry != nil else { break }
            apply(ReminderCue(periodic: rule, now: now))
        }
        if changed || state.entries != stack.shown {
            publishStack()
            layoutStack()
        }
    }

    // MARK: Layout

    private func stackWanted() -> Bool {
        guard Prefs.isNotchEnabled, geometry != nil, window != nil, !state.expanded, !collapsedByUser, !stack.isEmpty else { return false }
        return shouldAutoExpand(forReminder: true)
    }

    private func layoutStack() {
        let wanted = stackWanted()
        if wanted, !state.stackShown, let window {
            stopPolling()
            state.reduceMotion = Theme.reduceMotion
            state.cueHovered = false
            state.stackShown = true
            window.allowsKey = false; window.hasShadow = false; window.orderFrontRegardless()
            sizeStack(height: stackHeight)
        } else if !wanted, state.stackShown {
            state.stackShown = false
            state.cueHovered = false
            rearmAfterLeave = true
            placeCollapsed(animated: true)
            if pollTimer == nil, isNearTop(NSEvent.mouseLocation) { startPolling() }
        }
        ensureStackTimer()
    }

    private func scheduleStackLayout() {
        stackLayoutTask?.cancel()
        stackLayoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            self?.layoutStack()
        }
    }

    private func sizeStack(height: CGFloat) {
        guard height > 0 else { return }
        stackHeight = height
        guard state.stackShown, let window, let geo = geometry else { return }
        let frame = NotchLayout.expandedFrame(notch: geo.notchRect, screen: geo.screenFrame,
                                              contentHeight: height, width: 460, maxHeight: 360)
        guard targetFrame != frame else { return }
        place(window, at: frame, duration: 0.28, timing: CAMediaTimingFunction(controlPoints: 0.18, 0.85, 0.25, 1))
    }

    // MARK: Upkeep

    private func ensureStackTimer() {
        if stack.entries.isEmpty {
            stackTimer?.invalidate()
            stackTimer = nil
            return
        }
        guard stackTimer == nil else { return }
        let timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tickStack() }
        }
        RunLoop.main.add(timer, forMode: .common)
        stackTimer = timer
    }

    private func tickStack() {
        let now = Date()
        tickCount += 1
        var changed = false

        for entry in stack.entries where !state.busyKeys.contains(entry.key) && !isCurrent(entry) {
            stack.remove(entry.key)
            changed = true
        }
        // A rule outside its windows steps back; on returning it lands again with one more.
        for entry in stack.entries {
            guard let original = entry.cue.periodic else { continue }
            let rule = model.periodicReminders.first { $0.id == original.id } ?? original
            if stack.setDormant(entry.key, !rule.isActive(at: now), now: now), stack.entry(entry.key)?.dormant == false {
                collapsedByUser = false
                feature(entry.key)
                changed = true
            } else if stack.entry(entry.key)?.dormant != entry.dormant {
                changed = true
            }
        }
        if !state.cueHovered, !deferred.isEmpty {
            let waiting = deferred
            deferred.removeAll()
            state.deferredCount = 0
            for cue in waiting { apply(cue) }
        }
        if state.featuredKey != nil, now >= featuredUntil {
            if state.cueHovered || !state.busyKeys.isEmpty { featuredUntil = now.addingTimeInterval(featureDuration) }
            else { state.featuredKey = nil }
        }
        // A folded stack breathes once in a while so it does not become wallpaper.
        if !state.stackShown, !state.expanded, !stack.isEmpty, now.timeIntervalSince(lastPulse) >= 300 {
            lastPulse = now
            state.pulse += 1
        }
        if changed { publishStack() }
        layoutStack()
        followPointerWithDwell(now: now)
    }

    /// The stack goes to the screen the pointer is on once it has stayed there for a moment, so crossing
    /// a display on the way somewhere else does not make it jump back and forth.
    private func followPointerWithDwell(now: Date) {
        guard state.stackShown, let geo = geometry else { otherScreenSince = nil; return }
        let pointer = NSEvent.mouseLocation
        guard !NSMouseInRect(pointer, geo.screenFrame, false),
              NSScreen.screens.contains(where: { NSMouseInRect(pointer, $0.frame, false) }) else {
            otherScreenSince = nil
            return
        }
        guard let since = otherScreenSince else { otherScreenSince = now; return }
        if now.timeIntervalSince(since) >= 1.5 {
            otherScreenSince = nil
            rebuild()
        }
    }

    // MARK: Answers

    private func collapseStack() {
        collapsedByUser = true
        state.featuredKey = nil
        lastPulse = Date()
        layoutStack()
    }

    private func openQuickLookFromStack() {
        guard state.stackShown else { return }
        state.stackShown = false
        state.cueHovered = false
        expand(pinned: false)
        // Opened on purpose, so it stays until Esc or a click outside; the keyboard is left alone.
        state.pinned = true
        stopPolling()
    }

    private func openCue(_ key: String) {
        guard let entry = stack.entry(key) else { return }
        if let rule = entry.cue.periodic { model.revealPeriodic(rule.id) }
        else if let task = entry.cue.task { model.reveal(taskId: task.id) }
    }

    /// Complete, snooze or pause one row. The row stays, busy, until the runtime has answered.
    private func answer(_ key: String, snooze: Bool = false, pauseToday: Bool = false) {
        guard let entry = stack.entry(key), !state.busyKeys.contains(key) else { return }
        state.busyKeys.insert(key)
        state.errors[key] = nil
        var cue = entry.cue
        if let original = cue.periodic, let latest = model.periodicReminders.first(where: { $0.id == original.id }) {
            cue = ReminderCue(periodic: latest)
        }
        Task { [weak self] in
            guard let self else { return }
            let success: Bool
            if pauseToday, let rule = cue.periodic { success = await self.model.actOnPeriodic(rule, action: "pause_today") }
            else { success = await self.model.actOnCue(cue, snooze: snooze) }
            self.state.busyKeys.remove(key)
            if success {
                self.stack.remove(key)
                self.publishStack()
                self.layoutStack()
            } else {
                self.state.errors[key] = self.model.toast?.message ?? L10n.tr("暂时没能保存，请重试")
                self.featuredUntil = Date().addingTimeInterval(12)
                try? await Task.sleep(nanoseconds: 12_000_000_000)
                self.state.errors[key] = nil
            }
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
