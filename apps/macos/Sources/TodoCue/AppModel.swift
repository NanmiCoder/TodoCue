import AppKit
import Combine
import SwiftUI
import Foundation
import TodoCueKit

enum ConnectionState: Equatable {
    case noRuntime          // no connection.json
    case connecting
    case online
    case offline(String)

    var isOnline: Bool { self == .online }
    var label: String {
        switch self {
        case .noRuntime: return L10n.tr("未找到运行时")
        case .connecting: return L10n.tr("正在连接…")
        case .online: return L10n.tr("已连接")
        case .offline(let r): return L10n.tr("离线：\(r)")
        }
    }
}

enum PanelTab: String, CaseIterable, Identifiable {
    case today, upcoming, all
    var id: String { rawValue }
    var label: String {
        switch self { case .today: return L10n.tr("今日"); case .upcoming: return L10n.tr("即将到来"); case .all: return L10n.tr("全部") }
    }
}

enum Route: Equatable {
    case detail(String)
    case form(TaskDraft)
    case settings
    case calendar
    case completed
}

struct Toast: Equatable {
    let id = UUID()
    var message: String
    var undoTaskId: String? = nil
    var undoReschedule: UndoReschedule? = nil
    var undoOrderToken: String? = nil
    var undoOrderRevision: Int? = nil
    var isError = false
}

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    @Published private(set) var connection: ConnectionInfo?
    @Published private(set) var connectionState: ConnectionState = .connecting
    @Published private(set) var isPreparingRuntime = false
    @Published private(set) var runtimeSetupError: String?
    @Published private(set) var context: ContextInfo?
    @Published private(set) var today: TodayResult = .empty
    @Published private(set) var next: NextResult?
    @Published private(set) var allTasks: [TodoTask] = []
    @Published private(set) var upcoming: [TodoTask] = []
    @Published private(set) var seriesById: [String: Series] = [:]
    @Published private(set) var remindersByTask: [String: Reminder] = [:]
    @Published private(set) var isLoading = false
    @Published private(set) var ordering: APIClient.OrderingState = .empty
    @Published var draggedTask: TaskDrag?
    @Published var dropTarget: TaskDropTarget?
    @Published private(set) var dragPresentation: TaskDragPresentation?
    @Published var pendingMove: PendingTaskMove?
    /// A calendar drop whose new plan date lands after the task's own deadline.
    @Published var pendingReschedule: PendingReschedule?
    @Published private(set) var isMovingTask = false
    @Published var toast: Toast?
    @Published var tab: PanelTab = .today
    @Published var routes: [Route] = []
    @Published private(set) var calendarSpan: CalendarSpan = .month
    @Published private(set) var calendarAnchor = TCDate.todayString()
    @Published private(set) var calendarSelected = TCDate.todayString()
    /// nil = follow the height ladder; a value is an explicit user choice that overrides it.
    @Published var calendarGridExpanded: Bool?
    @Published private(set) var calendarBuckets: [String: CalendarDayBucket] = [:]
    /// Completed/cancelled/skipped tasks for the visible range — the board snapshot is todo-only.
    /// True when the last history fetch failed, so an empty day can say so instead of lying.
    @Published private(set) var calendarHistoryFailed = false
    private var historyTasks: [String: TodoTask] = [:]
    private var loadedHistory: (from: String, to: String)?
    private var historyRequest: Task<Void, Never>?
    /// Todo ids as of the last board. Only an id *leaving* this set can invalidate fetched history.
    private var calendarTodoIDs: Set<String> = []
    @Published private(set) var completedTasks: [TodoTask] = []
    @Published private(set) var completedHasMore = false
    @Published private(set) var isLoadingCompleted = false
    @Published private(set) var completedLoadFailed = false
    /// Until the history has been fetched once, live updates must not build a partial list that
    /// would then look like the whole story.
    private var completedLoaded = false
    private var completedWindow = CompletedHistory.pageSize
    private var completedRequest: Task<Void, Never>?
    /// Local changes that landed while a fetch was in flight, replayed once it resolves.
    private var completedPendingMerges: [TodoTask] = []
    @Published var pinned = false
    @Published var quickAddFocusRequest = 0
    @Published var quickAddText = ""
    @Published private(set) var isQuickAdding = false
    @Published private(set) var completingTaskIDs: Set<String> = []
    @Published private(set) var doctor: DoctorReport?

    /// Draft kept when an unsaved form is dismissed.
    @Published var savedDraft: TaskDraft?

    // Wiring to the AppKit shell.
    var onReminderCue: ((ReminderCue) -> Void)?
    var onOpenPanel: ((Bool) -> Void)?
    var onClosePanel: (() -> Void)?
    var onCollapseNotch: (() -> Void)?

    private(set) var client: APIClient?
    private var sse: SSEClient?
    private var sseTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var fileWatcher: DispatchSourceFileSystemObject?
    private var dirWatcher: DispatchSourceFileSystemObject?
    private var toastTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?

    init(client: APIClient? = nil) {
        self.client = client
        if client != nil { connectionState = .online }
    }

    var dragHint: String? {
        guard let drag = draggedTask else { return nil }
        if drag.surface == .calendar {
            guard let target = dropTarget, target.group != drag.group else {
                return L10n.tr("拖到某一天即可改期，Esc 取消")
            }
            return L10n.tr("改期至 \(TCDate.dateLabel(target.group))")
        }
        guard let target = dropTarget else { return L10n.tr("拖到任务之间调整顺序，Esc 取消") }
        if drag.surface == .list(.today) && drag.group != target.group { return L10n.tr("此分组由截止日期决定，请编辑日期") }
        if drag.group == target.group { return L10n.tr("调整执行顺序 · Esc 取消") }
        if drag.surface == .list(.all) { return L10n.tr("移至「\(target.group.isEmpty ? L10n.tr("未分组") : target.group)」") }
        return L10n.tr("改期至 \(TCDate.dateLabel(target.group))")
    }

    var canWrite: Bool { connectionState.isOnline && client != nil }
    var remaining: Int { today.remaining }
    var todayDateLabel: String {
        if let c = context, let d = TCDate.parseLocalDate(c.today) { return TCDate.dayWithWeekday(d) }
        return TCDate.dayWithWeekday(Date())
    }
    var projects: [String] {
        Array(Set(allTasks.compactMap { $0.project }.filter { !$0.isEmpty })).sorted()
    }

    func task(_ id: String) -> TodoTask? {
        if let t = allTasks.first(where: { $0.id == id }) { return t }
        if let t = today.items.first(where: { $0.task.id == id })?.task { return t }
        if let t = today.completed.first(where: { $0.id == id }) { return t }
        if let t = upcoming.first(where: { $0.id == id }) { return t }
        return nil
    }

    // MARK: - Lifecycle

    func start() {
        loadConnection()
        watchConnectionFile()
        prepareBundledRuntime()
    }

    func reconnect() {
        loadConnection()
        prepareBundledRuntime()
    }

    private func prepareBundledRuntime() {
        guard RuntimeBootstrap.isBundled(), !isPreparingRuntime else { return }
        isPreparingRuntime = true
        runtimeSetupError = nil
        Task {
            defer { isPreparingRuntime = false }
            do {
                try await RuntimeBootstrap.prepare()
                loadConnection()
            } catch {
                runtimeSetupError = error.localizedDescription
            }
        }
    }

    private func loadConnection() {
        let info = TodoCueHome.loadConnection()
        if info != connection || client == nil {
            connection = info
            if let info {
                client = APIClient(connection: info)
                connectionState = .connecting
                startSSE()
            } else {
                client = nil
                connectionState = .noRuntime
                sse?.stop(); sseTask?.cancel()
                schedulePoll()
            }
        } else {
            // Same connection: just re-sync.
            Task { await self.refreshAll() }
        }
    }

    private func schedulePoll() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard let self, !Task.isCancelled else { return }
            if self.connection == nil { self.loadConnection() }
        }
    }

    private func watchConnectionFile() {
        let dir = TodoCueHome.directory
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let fd = open(dir.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
        src.setEventHandler { [weak self] in
            // Runtime restarts rewrite connection.json (new token / pid).
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self?.loadConnection() }
        }
        src.setCancelHandler { close(fd) }
        src.resume()
        dirWatcher = src
    }

    private func startSSE() {
        ordering = .empty
        guard let client else { return }
        sse?.stop()
        sseTask?.cancel()
        let sse = SSEClient(client: client)
        self.sse = sse
        let stream = sse.start()
        sseTask = Task { [weak self] in
            for await item in stream {
                guard let self else { return }
                switch item {
                case .state(.connecting):
                    if self.connectionState != .online { self.connectionState = .connecting }
                case .state(.connected):
                    let wasOffline = !self.connectionState.isOnline
                    self.connectionState = .online
                    if wasOffline { await self.refreshAll() }
                case .state(.disconnected(let reason)):
                    self.connectionState = .offline(reason)
                case .event(let ev):
                    self.handle(ev)
                }
            }
        }
    }

    private func handle(_ ev: RuntimeEvent) {
        switch ev.type {
        case .reminderFired:
            guard let client, let taskId = ev.related?["taskId"] else { return }
            Task {
                guard let envelope = try? await client.task(taskId),
                      let cue = ReminderCue.from(ev, task: envelope.task) else { return }
                onReminderCue?(cue)
            }
        case .dayChanged, .runtimeStarted:
            loadedHistory = nil
            // Only a date rollover moves the reader. `.runtimeStarted` also fires on a connection
            // rewrite or a runtime restart, and yanking someone out of March 2027 for that is rude.
            if ev.type == .dayChanged, isShowingCalendar, calendarShowsToday { calendarGoToToday() }
            Task { await refreshAll() }
        case .taskCreated, .taskUpdated, .seriesCreated, .seriesUpdated, .reminderUpdated:
            scheduleLiveRefresh()
        }
    }

    /// Coalesces bursts of events into one refresh (150ms window).
    private func scheduleLiveRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            await self?.refreshLive()
        }
    }

    // MARK: - Loading

    func refreshAll() async {
        guard let client else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let board = client.board()
            async let ser = client.series()
            async let rem = client.reminders(status: [.pending, .submitted, .failed, .missed])
            let (snapshot, s, r) = try await (board, ser, rem)
            apply(snapshot)
            seriesById = Dictionary(uniqueKeysWithValues: s.map { ($0.id, $0) })
            remindersByTask = Dictionary(r.map { ($0.taskId, $0) }, uniquingKeysWith: { a, b in a.updatedAt > b.updatedAt ? a : b })
            if !connectionState.isOnline { connectionState = .online }
        } catch {
            handleLoadError(error)
        }
    }

    func refreshLive() async {
        guard let client else { return }
        do {
            async let board = client.board()
            async let rem = client.reminders(status: [.pending, .submitted, .failed, .missed])
            let (snapshot, r) = try await (board, rem)
            apply(snapshot)
            remindersByTask = Dictionary(r.map { ($0.taskId, $0) }, uniquingKeysWith: { a, b in a.updatedAt > b.updatedAt ? a : b })
        } catch {
            handleLoadError(error)
        }
    }

    private func apply(_ board: APIClient.Board) {
        // Keep drop targets stationary while dragging and reject older in-flight responses.
        guard draggedTask == nil, dragPresentation == nil, !isMovingTask, board.ordering.revision >= ordering.revision else { return }
        withAnimation(Theme.listChange) {
            context = board.context
            today = board.today
            next = board.next
            allTasks = board.all
            upcoming = board.upcoming
            ordering = board.ordering
        }
        // `refreshLive` reaches here on every SSE burst but only replaces todo snapshots, so the
        // calendar's fetched history would otherwise stay stale until the route is reopened.
        // Invalidate on content, never on arrival: an unconditional reset would refetch a
        // four-month window on every event and cancel the previous request each time, so a steady
        // stream of events — a bulk agent write, or series top-up — would starve it entirely.
        // Without this a row's `version` goes stale the moment anything edits the task elsewhere,
        // and reopening it 409s identically on every retry until the route is popped.
        if isShowingCompleted, !isLoadingCompleted { loadCompleted() }
        if isShowingCalendar {
            let todoIDs = Set(allTasks.map(\.id))
            if !calendarTodoIDs.subtracting(todoIDs).isEmpty { loadedHistory = nil }
            calendarTodoIDs = todoIDs
            refreshCalendar()
        }
    }

    func beginTaskDrag(_ task: TodoTask, surface: DragSurface, group: String) -> Bool {
        guard canWrite, !isMovingTask, dragPresentation == nil, pendingMove == nil, task.status == .todo,
              !completingTaskIDs.contains(task.id) else { return false }
        draggedTask = TaskDrag(task: task, surface: surface, group: group, revision: ordering.revision)
        return true
    }

    func updateTaskDrag(at point: NSPoint, origin: NSPoint, in window: NSWindow) {
        guard let drag = draggedTask else { return }
        let source = TaskDragSlot(surface: drag.surface, group: drag.group, kind: .row, taskID: drag.task.id)
        let frames = TaskDropRegion.RegionView.frames(in: window, surface: drag.surface)
        guard let sourceFrame = frames.first(where: { $0.slot == source }) else { return }
        let target = TaskDropRegion.RegionView.target(at: point, in: window, surface: drag.surface)
        let grab = dragPresentation?.grabOffset ?? CGPoint(x: origin.x - sourceFrame.rect.minX, y: -origin.y - sourceFrame.rect.minY)
        let translation = CGSize(width: point.x - grab.x - sourceFrame.rect.minX,
                                 height: -point.y - grab.y - sourceFrame.rect.minY)
        let presentation = TaskDragPresentation(id: dragPresentation?.id ?? UUID(), source: source, grabOffset: grab,
                                               translation: translation,
                                               projection: .evaluate(frames: frames, source: source, target: target))
        if dropTarget != target { dropTarget = target }
        if dragPresentation != presentation { dragPresentation = presentation }
    }

    func dragOffset(_ slot: TaskDragSlot) -> CGFloat { dragPresentation?.projection.offsets[slot] ?? 0 }

    private func settleDrag(returning: Bool) {
        guard var presentation = dragPresentation else { return }
        presentation.phase = returning ? .returning : .landing
        presentation.translation = returning ? .zero : presentation.projection.landingOffset
        if returning { presentation.projection = TaskDragProjection() }
        presentation.settleUntil = Date().addingTimeInterval(Theme.reduceMotion ? 0.01 : Theme.dragSettleDuration)
        dragPresentation = presentation
    }

    private func waitForDragSettle() async {
        if let deadline = dragPresentation?.settleUntil {
            let remaining = max(0, deadline.timeIntervalSinceNow)
            if remaining > 0 { try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000)) }
        }
    }

    func endTaskDrag() {
        draggedTask = nil
        dropTarget = nil
        // The mouse-up cleanup must not clear the landing pose of a submitted move.
        guard dragPresentation?.phase == .dragging else {
            if dragPresentation == nil { scheduleLiveRefresh() }
            return
        }
        settleDrag(returning: true)
        let id = dragPresentation?.id
        Task {
            await waitForDragSettle()
            guard dragPresentation?.id == id, dragPresentation?.phase == .returning else { return }
            var transaction = Transaction(); transaction.disablesAnimations = true
            withTransaction(transaction) { dragPresentation = nil }
            scheduleLiveRefresh()
        }
    }

    func dropTask(at target: TaskDropTarget) -> Bool {
        guard let drag = draggedTask, canWrite, !isMovingTask,
              target.surface == drag.surface, target.beforeId != drag.task.id else { return false }
        // The calendar drags to change a date. It cannot go through `moveTask`: that path rejects a
        // source whose plan date is not after today, and refuses any target on or before today —
        // so "drag the overdue one onto today" would fail. It patches the plan date instead.
        if drag.surface == .calendar {
            guard target.group != drag.group else { return false }
            // Deliberately no `settleDrag(returning: false)`. That parks the presentation in
            // `.landing`, and only `finishOrderMutation` — which is the ordering path, not this one
            // — ever clears it; `endTaskDrag` skips anything that is not `.dragging`. A leaked
            // presentation permanently blocks `apply(_:)` and `beginTaskDrag`, so one calendar drag
            // would freeze every snapshot and every drag in the app. `TaskDragHandle.finish()`
            // always calls `endTaskDrag()` right after this, which settles and clears properly;
            // the optimistic `merge` in `reschedule` is what moves the row to its new day.
            draggedTask = nil
            dropTarget = nil
            reschedule(drag.task, to: target.group)
            return true
        }
        guard drag.surface != .list(.today) || target.group == drag.group else { return false }
        guard let move = PendingTaskMove(drag: drag, target: target) else { return false }
        settleDrag(returning: false)
        draggedTask = nil
        dropTarget = nil
        submitMove(move)
        return true
    }

    /// Patch the plan date, keeping the time of day, the deadline and the reminder.
    func reschedule(_ task: TodoTask, to date: String, confirmedPastDeadline: Bool = false) {
        guard canWrite, !isMovingTask, let client else { return }
        if !confirmedPastDeadline, TaskRescheduling.landsAfterDeadline(task, on: date) {
            pendingReschedule = PendingReschedule(task: task, date: date)
            return
        }
        pendingReschedule = nil
        isMovingTask = true
        Task {
            do {
                let updated = try await client.updateTask(task.id, TaskRescheduling.plan(task, on: date),
                                                          expectedVersion: task.version)
                merge(updated)
                // Undo targets the version this write produced, so a later edit from the CLI, an
                // agent or another window makes the undo conflict instead of silently reverting it.
                showToast(Toast(message: L10n.tr("已改期至 \(TCDate.dateLabel(date))，截止与提醒保持原值"),
                                undoReschedule: UndoReschedule(task: task, expectedVersion: updated.version)))
            } catch {
                showToast(Toast(message: (error as? APIError)?.isVersionConflict == true
                                ? L10n.tr("任务已在别处修改，请刷新后重试")
                                : L10n.tr("改期失败：\(error.localizedDescription)"), isError: true))
            }
            // `apply` refuses a snapshot while a mutation is in flight, so clear the flag first;
            // a `defer` here would run after the await and make the reconcile a no-op.
            isMovingTask = false
            await refreshLive()
        }
    }

    func undoReschedule(_ undo: UndoReschedule) {
        guard canWrite, !isMovingTask, let client else { return }
        toast = nil
        isMovingTask = true
        Task {
            do {
                let restored = try await client.updateTask(undo.taskId, undo.payload,
                                                           expectedVersion: undo.expectedVersion)
                merge(restored)
            } catch {
                showToast(Toast(message: L10n.tr("撤销失败，任务可能已在别处修改"), isError: true))
            }
            isMovingTask = false
            await refreshLive()
        }
    }

    func confirmMove(_ move: PendingTaskMove) {
        pendingMove = nil
        submitMove(move, allowPastDeadline: true)
    }

    private func submitMove(_ move: PendingTaskMove, allowPastDeadline: Bool = false) {
        guard canWrite, !isMovingTask, let client else { return }
        isMovingTask = true
        Task {
            var confirmation: PendingTaskMove?
            var notification: Toast?
            var restorePreview = false
            do {
                let result = try await client.moveTask(move.drag.task.id, payload: move.payload(allowPastDeadline: allowPastDeadline))
                ordering = result.ordering
                notification = Toast(message: move.message, undoOrderToken: result.undoToken, undoOrderRevision: result.ordering.revision)
            } catch let error as APIError where error.code == "DEADLINE_CONFIRMATION_REQUIRED" {
                confirmation = move
                restorePreview = true
            } catch {
                restorePreview = true
                notification = Toast(message: (error as? APIError)?.isVersionConflict == true ? L10n.tr("任务列表已在别处修改，请重新拖动") : L10n.tr("移动失败：\(error.localizedDescription)"), isError: true)
            }
            await finishOrderMutation(restorePreview: restorePreview)
            pendingMove = confirmation
            if let notification { showToast(notification) }
        }
    }

    private func finishOrderMutation(restorePreview: Bool = false) async {
        if restorePreview { settleDrag(returning: true) }
        // Do not allow a second drag with the new revision but old rows/versions.
        // Publish the committed snapshot and unlock dragging in the same actor turn.
        do {
            guard let client else { isMovingTask = false; return }
            let snapshot = try await client.board()
            await waitForDragSettle()
            isMovingTask = false
            if dragPresentation != nil {
                // Replace projected positions with committed positions in one frame.
                var transaction = Transaction(); transaction.disablesAnimations = true
                withTransaction(transaction) {
                    dragPresentation = nil
                    apply(snapshot)
                }
            } else { apply(snapshot) }
        } catch {
            settleDrag(returning: true)
            await waitForDragSettle()
            dragPresentation = nil
            isMovingTask = false
            handleLoadError(error)
        }
    }

    func hasManualOrder(view: PanelTab, group: String) -> Bool {
        ordering.groups.contains { $0.view == view.rawValue && $0.group == group }
    }

    func resetOrder(view: PanelTab, group: String) {
        guard canWrite, !isMovingTask, draggedTask == nil, dragPresentation == nil, let client else { return }
        let revision = ordering.revision
        isMovingTask = true
        Task {
            do {
                let result = try await client.resetOrder(view: view.rawValue, group: group, revision: revision)
                ordering = result.ordering
                showToast(Toast(message: L10n.tr("已恢复自动排序"), undoOrderToken: result.undoToken, undoOrderRevision: result.ordering.revision))
            } catch { showToast(Toast(message: L10n.tr("恢复排序失败：\(error.localizedDescription)"), isError: true)) }
            await finishOrderMutation()
        }
    }

    func undoOrder(token: String, revision: Int) {
        guard canWrite, !isMovingTask, let client else { return }
        toast = nil
        isMovingTask = true
        Task {
            do {
                let result = try await client.undoOrder(token: token, revision: revision)
                ordering = result.ordering
                showToast(Toast(message: L10n.tr("已撤销移动或排序")))
            } catch { showToast(Toast(message: L10n.tr("列表已改变或连接中断，撤销失败：\(error.localizedDescription)"), isError: true)) }
            await finishOrderMutation()
        }
    }

    func loadDoctor() async {
        guard let client else { return }
        doctor = try? await client.doctor()
    }

    func loadSeries(_ id: String) async {
        guard let client, seriesById[id] == nil else { return }
        if let env = try? await client.series(id) { seriesById[id] = env.series }
    }

    private func handleLoadError(_ error: Error) {
        if let e = error as? APIError, case .http(let status, _, _) = e, status == 401 {
            connectionState = .offline(L10n.tr("令牌无效，等待运行时重启"))
        } else if case APIError.transport(let m) = error {
            connectionState = .offline(m)
        } else {
            connectionState = .offline(error.localizedDescription)
        }
    }

    // MARK: - Writes

    private func perform(_ label: String, _ op: @escaping () async throws -> TodoTask?) async -> TodoTask? {
        guard canWrite else {
            showToast(Toast(message: L10n.tr("离线状态下无法\(label)"), isError: true)); return nil
        }
        do {
            let t = try await op()
            if let t { merge(t) }
            scheduleLiveRefresh()
            return t
        } catch let e as APIError where e.isVersionConflict {
            await refreshLive()
            showToast(Toast(message: L10n.tr("任务已在别处修改，已刷新"), isError: true))
        } catch {
            showToast(Toast(message: L10n.tr("\(label)失败：\(error.localizedDescription)"), isError: true))
        }
        return nil
    }

    /// Apply a returned task to local snapshots immediately.
    private func merge(_ t: TodoTask) {
        withAnimation(Theme.listChange) {
            if t.status == .todo {
                if let i = allTasks.firstIndex(where: { $0.id == t.id }) { allTasks[i] = t } else { allTasks.append(t) }
            } else {
                allTasks.removeAll { $0.id == t.id }
                today.items.removeAll { $0.task.id == t.id }
                upcoming.removeAll { $0.id == t.id }
                if t.status == .done, !today.completed.contains(where: { $0.id == t.id }) { today.completed.insert(t, at: 0) }
            }
            if let i = today.items.firstIndex(where: { $0.task.id == t.id }) { today.items[i].task = t }
            if let i = upcoming.firstIndex(where: { $0.id == t.id }) { upcoming[i] = t }
            if t.status != .done { today.completed.removeAll { $0.id == t.id } }
            today.remaining = today.items.filter { $0.task.status == .todo }.count
            mergeCalendarHistory(t)
            mergeCompleted(t)
        }
    }

    func complete(_ task: TodoTask) {
        guard canWrite, completingTaskIDs.insert(task.id).inserted else { return }
        Task {
            defer { completingTaskIDs.remove(task.id) }
            if let t = await perform(L10n.tr("完成"), { try await self.client!.complete(task.id, expectedVersion: task.version) }) {
                showToast(Toast(message: L10n.tr("已完成「\(t.title)」"), undoTaskId: t.id))
            }
        }
    }

    func actOnCue(_ cue: ReminderCue, snooze: Bool) async -> Bool {
        guard let client else { return false }
        let task = self.task(cue.task.id) ?? cue.task
        return await perform(snooze ? L10n.tr("稍后提醒") : L10n.tr("完成"), {
            if snooze { return try await client.snooze(task.id, expectedVersion: task.version) }
            return try await client.complete(task.id, expectedVersion: task.version)
        }) != nil
    }

    func undoComplete(_ id: String) {
        toast = nil
        Task { _ = await perform(L10n.tr("撤销"), { try await self.client!.reopen(id) }) }
    }

    func reopen(_ task: TodoTask) { Task { _ = await perform(L10n.tr("重新打开"), { try await self.client!.reopen(task.id, expectedVersion: task.version) }) } }
    func cancel(_ task: TodoTask) { Task { _ = await perform(L10n.tr("取消"), { try await self.client!.cancel(task.id, expectedVersion: task.version) }) } }
    func skip(_ task: TodoTask) { Task { _ = await perform(L10n.tr("跳过"), { try await self.client!.skip(task.id, expectedVersion: task.version) }) } }

    func snooze(_ task: TodoTask, minutes: Int = 10) {
        Task {
            if await perform(L10n.tr("稍后提醒"), { try await self.client!.snooze(task.id, minutes: minutes, expectedVersion: task.version) }) != nil {
                showToast(Toast(message: L10n.tr("将在 \(minutes) 分钟后提醒")))
            }
        }
    }

    func moveToTomorrow(_ task: TodoTask) {
        let p = TaskRescheduling.tomorrow(task)
        Task {
            if await perform(L10n.tr("改期"), { try await self.client!.updateTask(task.id, p, expectedVersion: task.version) }) != nil {
                showToast(Toast(message: L10n.tr("已改期到明天")))
            }
        }
    }

    func stopSeries(_ id: String) {
        guard canWrite, let client else { return }
        Task {
            do {
                let r = try await client.stopSeries(id)
                seriesById[id] = r.series
                showToast(Toast(message: L10n.tr("已停止系列，取消了 \(r.cancelledTaskIds.count) 个未来实例")))
                await refreshLive()
            } catch {
                showToast(Toast(message: L10n.tr("停止系列失败：\(error.localizedDescription)"), isError: true))
            }
        }
    }

    /// Quick add from the panel field.
    func quickAdd(on date: String? = nil) {
        let original = quickAddText
        Task {
            if await quickAdd(title: original, on: date), quickAddText == original { quickAddText = "" }
        }
    }

    /// Creates a task with only a title, planned for `date` (today when omitted).
    /// Returns true when it was saved.
    @discardableResult
    func quickAdd(title: String, on date: String? = nil) async -> Bool {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canWrite, !isQuickAdding, !t.isEmpty else { return false }
        isQuickAdding = true
        defer { isQuickAdding = false }
        let day = date ?? TCDate.todayString()
        var p = TaskPayload()
        p.set("title", t)
        p.set("scheduledDate", day)
        guard await perform(L10n.tr("添加"), { try await self.client!.createTask(p).task }) != nil else { return false }
        showToast(Toast(message: L10n.tr("已添加「\(t)」")))
        return true
    }

    /// Saves a form draft. Returns an error message to show inline, or nil on success.
    func save(_ draft: TaskDraft) async -> String? {
        guard canWrite, let client else { return L10n.tr("离线状态下无法保存") }
        if let err = draft.validate() { return err }
        do {
            if let id = draft.editingTaskId {
                let t = try await client.updateTask(id, draft.updatePayload(), expectedVersion: draft.version)
                merge(t)
                showToast(Toast(message: L10n.tr("已保存")))
            } else {
                let env = try await client.createTask(draft.createPayload(), idempotencyKey: draft.saveIdempotencyKey)
                merge(env.task)
                if let s = env.series { seriesById[s.id] = s }
                showToast(Toast(message: env.series == nil ? L10n.tr("已添加「\(env.task.title)」") : L10n.tr("已创建重复任务")))
            }
            savedDraft = nil
            scheduleLiveRefresh()
            return nil
        } catch let e as APIError where e.isVersionConflict {
            await refreshLive()
            return L10n.tr("任务已在别处修改，已刷新，请重新编辑")
        } catch {
            return error.localizedDescription
        }
    }

    func exportJSON() {
        guard let client else { return }
        Task {
            do {
                let data = try await client.exportJSON()
                let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
                let name = "todocue-export-\(TCDate.todayString()).json"
                let url = dir.appendingPathComponent(name)
                try data.write(to: url)
                NSWorkspace.shared.activateFileViewerSelecting([url])
                showToast(Toast(message: L10n.tr("已导出到 \(name)")))
            } catch {
                showToast(Toast(message: L10n.tr("导出失败：\(error.localizedDescription)"), isError: true))
            }
        }
    }

    func requestNotificationAuthorization() async -> String {
        guard let client else { return L10n.tr("未连接") }
        do {
            let a = try await client.requestNotificationAuthorization()
            await loadDoctor()
            return a
        } catch { return error.localizedDescription }
    }

    func sendTestNotification() async -> String {
        guard let client else { return L10n.tr("未连接") }
        do {
            let r = try await client.sendTestNotification()
            return r.ok ? L10n.tr("已提交系统（\(r.channel ?? "?")）") : L10n.tr("发送失败")
        } catch { return error.localizedDescription }
    }

    // MARK: - Navigation

    func showToast(_ t: Toast) {
        toast = t
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            let hasUndo = t.undoTaskId != nil || t.undoOrderToken != nil || t.undoReschedule != nil
            try? await Task.sleep(nanoseconds: hasUndo ? 10_000_000_000 : 5_000_000_000)
            guard !Task.isCancelled else { return }
            if self?.toast?.id == t.id { self?.toast = nil }
        }
    }

    func openPanel() { onOpenPanel?(false) }

    func reveal(taskId: String) {
        preserveDraft()
        onCollapseNotch?()
        routes = [.detail(taskId)]
        onOpenPanel?(false)
        if task(taskId) == nil { Task { await refreshLive() } }
    }

    func openToday() {
        preserveDraft()
        onCollapseNotch?()
        routes = []
        tab = .today
        onOpenPanel?(false)
    }

    func newTask() {
        if case .form = routes.last { onOpenPanel?(true); return }
        routes = [.form(savedDraft ?? TaskDraft())]
        onOpenPanel?(true)
    }

    func edit(_ task: TodoTask) {
        let draft = savedDraft?.editingTaskId == task.id ? savedDraft! : TaskDraft(editing: task)
        presentForm(draft)
    }

    func presentForm(_ draft: TaskDraft) {
        routes.append(.form(draft))
        onOpenPanel?(true)
    }

    func showSettings() {
        if routes.last != .settings { routes.append(.settings) }
        onOpenPanel?(true)
        Task { await loadDoctor() }
    }

    // MARK: - Completed history

    var isShowingCompleted: Bool { routes.contains(.completed) }
    /// The zone the runtime decides dates in; the client must group the same way it does.
    var runtimeTimezone: String { context?.timezone ?? TimeZone.current.identifier }
    /// The runtime's own "today". Grouping uses the runtime zone, so the heading that says
    /// 今天 has to be decided in that zone too, or a differently-configured runtime labels
    /// today's group with an absolute date.
    var runtimeToday: String { context?.today ?? TCDate.todayString() }

    func showCompleted() {
        preserveDraft()
        if let index = routes.firstIndex(of: .completed) { routes.removeSubrange(routes.index(after: index)...) }
        else { routes.append(.completed) }
        onOpenPanel?(false)
        loadCompleted(reset: true)
    }

    func loadCompleted(reset: Bool = false) {
        guard let client else { return }
        // A reset supersedes whatever is in flight; without cancelling, the older, larger fetch
        // would land afterwards and silently undo the reset.
        if reset {
            completedRequest?.cancel()
            completedWindow = CompletedHistory.pageSize
        } else if isLoadingCompleted {
            return
        }
        let window = min(completedWindow, CompletedHistory.maxWindow)
        let probe = CompletedHistory.probe(window: window)
        isLoadingCompleted = true
        completedRequest = Task {
            defer { isLoadingCompleted = false }
            do {
                let tasks = try await client.tasks(status: [.done], limit: probe)
                guard !Task.isCancelled else { return }
                completedHasMore = CompletedHistory.hasMore(window: window, received: tasks.count)
                completedTasks = Array(tasks.prefix(window))
                completedLoaded = true
                completedLoadFailed = false
                // Anything completed while this was in flight is newer than the response.
                for pending in completedPendingMerges { mergeCompleted(pending) }
                completedPendingMerges.removeAll()
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                completedPendingMerges.removeAll()
                completedLoadFailed = true
            }
        }
    }

    func loadMoreCompleted() {
        guard completedHasMore, !isLoadingCompleted else { return }
        completedWindow = min(completedWindow + CompletedHistory.pageSize, CompletedHistory.maxWindow)
        loadCompleted()
    }

    /// Keeps the history in step with a local change, so reopening a task from this very list
    /// removes it immediately instead of waiting for a refetch.
    private func mergeCompleted(_ task: TodoTask) {
        guard completedLoaded else { return }
        // A response computed before this change is about to overwrite the list; replay then.
        if isLoadingCompleted { completedPendingMerges.append(task) }
        completedTasks = CompletedHistory.merging(completedTasks, with: task, hasMore: completedHasMore)
    }

    // MARK: - Calendar

    /// Anywhere in the stack, not just on top: tapping an agenda row pushes `.detail` over the
    /// calendar, and the calendar behind it must still take live updates or it goes stale — and
    /// then submits a stale `expectedVersion` when the user acts on it after popping back.
    var isShowingCalendar: Bool { routes.contains(.calendar) }

    /// Opens the calendar on today. Unlike the form, it has no text field, so it must not steal
    /// keyboard focus — `NavigationTests` pins that only explicit editing does.
    func showCalendar() {
        preserveDraft()
        let today = TCDate.todayString()
        calendarSpan = .month
        calendarAnchor = today
        calendarSelected = today
        calendarGridExpanded = nil
        // Reopening returns to the calendar already on the stack instead of pushing a second one.
        if let index = routes.firstIndex(of: .calendar) { routes.removeSubrange(routes.index(after: index)...) }
        else { routes.append(.calendar) }
        onOpenPanel?(false)
        refreshCalendar()
        // `refreshLive` never refetches series, so a repeat created since the last full refresh
        // would be missing from the projection until then.
        Task { await refreshSeries() }
    }

    func setCalendar(span: CalendarSpan? = nil, anchor: String? = nil, selected: String? = nil) {
        var rangeChanged = false
        if let span, span != calendarSpan { calendarSpan = span; calendarGridExpanded = nil; rangeChanged = true }
        if let anchor, anchor != calendarAnchor { calendarAnchor = anchor; rangeChanged = true }
        if let selected { calendarSelected = selected }
        // Picking a day inside the visible span changes the selection, not the data — rebuilding
        // 42 buckets (and re-deriving every `planDate`) on each cell tap would be pure waste.
        if rangeChanged { refreshCalendar() }
    }

    func stepCalendar(_ steps: Int) {
        let anchor = CalendarRange.shift(span: calendarSpan, anchor: calendarAnchor, by: steps)
        // A month step keeps the day of month — `shift` already clamped it — so paging forward and
        // back returns you where you were. A week step keeps the weekday, which is the same idea.
        let selected: String
        if calendarSpan == .month {
            selected = anchor
        } else {
            let days = CalendarRange.days(span: .week, anchor: anchor, firstWeekday: calendarFirstWeekday)
            selected = days.first { CivilDate.isoWeekday($0) == CivilDate.isoWeekday(calendarSelected) } ?? anchor
        }
        setCalendar(anchor: anchor, selected: selected)
    }

    func calendarGoToToday() {
        let today = TCDate.todayString()
        setCalendar(anchor: today, selected: today)
    }

    var calendarFirstWeekday: Int { CalendarRange.firstWeekday(L10n.language) }

    /// Distinguishes "this day is empty" from "the completed history could not be loaded".
    var calendarHistoryUnavailable: Bool { calendarHistoryFailed || client == nil }

    var calendarShowsToday: Bool {
        CalendarRange.contains(span: calendarSpan, anchor: calendarAnchor,
                               date: TCDate.todayString(), firstWeekday: calendarFirstWeekday)
    }

    func calendarBucket(_ date: String) -> CalendarDayBucket { calendarBuckets[date] ?? .init() }

    /// Rebuilds the buckets and, when the visible range moved outside what has been fetched,
    /// reloads the completed history behind it.
    private func refreshCalendar() {
        let bounds = CalendarRange.bounds(span: calendarSpan, anchor: calendarAnchor, firstWeekday: calendarFirstWeekday)
        rebuildCalendarBuckets(from: bounds.from, to: bounds.to)
        let covered = loadedHistory.map { $0.from <= bounds.from && $0.to >= bounds.to } ?? false
        if !covered { loadCalendarHistory(from: bounds.from, to: bounds.to) }
    }

    /// `CalendarBuckets.build` walks every task and allocates date formatters through
    /// `TodoTask.planDate`; it must never run from a view body.
    private func rebuildCalendarBuckets(from: String, to: String) {
        // `Dictionary.values` has no defined order and rehashes on mutation, which would let one
        // completion visibly reshuffle an unrelated day's completed list.
        let history = historyTasks.values.sorted { ($0.completedAt ?? $0.updatedAt, $0.id) > ($1.completedAt ?? $1.updatedAt, $1.id) }
        calendarBuckets = CalendarBuckets.build(todo: allTasks, history: history,
                                                series: Array(seriesById.values), from: from, to: to)
    }

    /// Fetches a month of padding on each side so ordinary paging does not hit the network.
    private func loadCalendarHistory(from: String, to: String) {
        guard let client else { return }
        let paddedFrom = CivilDate.addingMonths(-1, to: from)
        let paddedTo = CivilDate.addingMonths(1, to: to)
        historyRequest?.cancel()
        historyRequest = Task { [weak self] in
            do {
                let tasks = try await client.tasks(status: [.done, .cancelled, .skipped],
                                                   from: paddedFrom, to: paddedTo,
                                                   includeUnscheduled: false, limit: 1000)
                guard !Task.isCancelled, let self else { return }
                // Replace the window rather than merge into it: tasks that left `done` disappear,
                // and paging across a year cannot accumulate every completed task in the session.
                self.historyTasks = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
                self.loadedHistory = (paddedFrom, paddedTo)
                self.calendarTodoIDs = Set(self.allTasks.map(\.id))
                self.calendarHistoryFailed = false
                self.rebuildCalendarBuckets(from: from, to: to)
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled, let self else { return }
                self.calendarHistoryFailed = true
            }
        }
    }

    private func refreshSeries() async {
        guard let client, let series = try? await client.series() else { return }
        seriesById = Dictionary(uniqueKeysWithValues: series.map { ($0.id, $0) })
        if isShowingCalendar { refreshCalendar() }
    }

    /// Keeps the history buckets in step with an optimistic local mutation, so completing a task
    /// from the calendar greys its dot instead of making the task disappear.
    private func mergeCalendarHistory(_ task: TodoTask) {
        if task.status == .todo { historyTasks.removeValue(forKey: task.id) }
        else { historyTasks[task.id] = task }
        guard isShowingCalendar else { return }
        let bounds = CalendarRange.bounds(span: calendarSpan, anchor: calendarAnchor, firstWeekday: calendarFirstWeekday)
        rebuildCalendarBuckets(from: bounds.from, to: bounds.to)
    }

    func preserveDraft() {
        if case .form(let d) = routes.last, d.hasContent { savedDraft = d }
    }

    func pop(preservingDraft: Bool = true) {
        if preservingDraft { preserveDraft() }
        if !routes.isEmpty { routes.removeLast() }
    }

    func focusQuickAdd() {
        preserveDraft()
        routes = []
        quickAddFocusRequest += 1
        onOpenPanel?(true)
    }

    /// Esc: close top layer first; close the panel only from the root (unless pinned).
    func handleEscape() {
        if draggedTask != nil { endTaskDrag(); return }
        if pendingMove != nil { pendingMove = nil; return }
        if !routes.isEmpty {
            pop()
        } else if !pinned {
            onClosePanel?()
        }
    }
}
