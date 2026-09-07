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
        case .noRuntime: return "未找到运行时"
        case .connecting: return "正在连接…"
        case .online: return "已连接"
        case .offline(let r): return "离线：\(r)"
        }
    }
}

enum PanelTab: String, CaseIterable, Identifiable {
    case today, upcoming, all
    var id: String { rawValue }
    var label: String {
        switch self { case .today: return "今日"; case .upcoming: return "即将到来"; case .all: return "全部" }
    }
}

enum Route: Equatable {
    case detail(String)
    case form(TaskDraft)
    case settings
}

struct Toast: Equatable {
    let id = UUID()
    var message: String
    var undoTaskId: String? = nil
    var isError = false
}

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    @Published private(set) var connection: ConnectionInfo?
    @Published private(set) var connectionState: ConnectionState = .connecting
    @Published private(set) var context: ContextInfo?
    @Published private(set) var today: TodayResult = .empty
    @Published private(set) var next: NextResult?
    @Published private(set) var allTasks: [TodoTask] = []
    @Published private(set) var upcoming: [TodoTask] = []
    @Published private(set) var seriesById: [String: Series] = [:]
    @Published private(set) var remindersByTask: [String: Reminder] = [:]
    @Published private(set) var isLoading = false
    @Published var toast: Toast?
    @Published var tab: PanelTab = .today
    @Published var routes: [Route] = []
    @Published var pinned = false
    @Published var quickAddFocusRequest = 0
    @Published var quickAddText = ""
    @Published private(set) var isQuickAdding = false
    @Published private(set) var completingTaskIDs: Set<String> = []
    @Published private(set) var doctor: DoctorReport?

    /// Draft kept when an unsaved form is dismissed.
    @Published var savedDraft: TaskDraft?

    // Wiring to the AppKit shell.
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
    }

    func reconnect() {
        loadConnection()
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
        case .dayChanged, .runtimeStarted:
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
            async let ctx = client.context()
            async let td = client.today()
            async let nx = client.next()
            async let all = client.tasks(status: [.todo])
            async let up = client.tasks(status: [.todo], from: TCDate.tomorrowString(), includeUnscheduled: false)
            async let ser = client.series()
            async let rem = client.reminders(status: [.pending, .submitted, .failed, .missed])
            let (c, t, n, a, u, s, r) = try await (ctx, td, nx, all, up, ser, rem)
            context = c
            apply(today: t, next: n, all: a, upcoming: u)
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
            async let td = client.today()
            async let nx = client.next()
            async let all = client.tasks(status: [.todo])
            async let up = client.tasks(status: [.todo], from: TCDate.tomorrowString(), includeUnscheduled: false)
            async let rem = client.reminders(status: [.pending, .submitted, .failed, .missed])
            let (t, n, a, u, r) = try await (td, nx, all, up, rem)
            apply(today: t, next: n, all: a, upcoming: u)
            remindersByTask = Dictionary(r.map { ($0.taskId, $0) }, uniquingKeysWith: { a, b in a.updatedAt > b.updatedAt ? a : b })
        } catch {
            handleLoadError(error)
        }
    }

    private func apply(today t: TodayResult, next n: NextResult, all a: [TodoTask], upcoming u: [TodoTask]) {
        let todayDate = t.date
        withAnimation(Theme.listChange) {
            today = t
            next = n
            allTasks = a
            upcoming = u.filter { ($0.planDate ?? "") > todayDate }
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
            connectionState = .offline("令牌无效，等待运行时重启")
        } else if case APIError.transport(let m) = error {
            connectionState = .offline(m)
        } else {
            connectionState = .offline(error.localizedDescription)
        }
    }

    // MARK: - Writes

    private func perform(_ label: String, _ op: @escaping () async throws -> TodoTask?) async -> TodoTask? {
        guard canWrite else {
            showToast(Toast(message: "离线状态下无法\(label)", isError: true)); return nil
        }
        do {
            let t = try await op()
            if let t { merge(t) }
            scheduleLiveRefresh()
            return t
        } catch let e as APIError where e.isVersionConflict {
            await refreshLive()
            showToast(Toast(message: "任务已在别处修改，已刷新", isError: true))
        } catch {
            showToast(Toast(message: "\(label)失败：\(error.localizedDescription)", isError: true))
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
        }
    }

    func complete(_ task: TodoTask) {
        guard canWrite, completingTaskIDs.insert(task.id).inserted else { return }
        Task {
            defer { completingTaskIDs.remove(task.id) }
            if let t = await perform("完成", { try await self.client!.complete(task.id, expectedVersion: task.version) }) {
                showToast(Toast(message: "已完成「\(t.title)」", undoTaskId: t.id))
            }
        }
    }

    func undoComplete(_ id: String) {
        toast = nil
        Task { _ = await perform("撤销", { try await self.client!.reopen(id) }) }
    }

    func reopen(_ task: TodoTask) { Task { _ = await perform("重新打开", { try await self.client!.reopen(task.id, expectedVersion: task.version) }) } }
    func cancel(_ task: TodoTask) { Task { _ = await perform("取消", { try await self.client!.cancel(task.id, expectedVersion: task.version) }) } }
    func skip(_ task: TodoTask) { Task { _ = await perform("跳过", { try await self.client!.skip(task.id, expectedVersion: task.version) }) } }

    func snooze(_ task: TodoTask, minutes: Int = 10) {
        Task {
            if await perform("稍后提醒", { try await self.client!.snooze(task.id, minutes: minutes, expectedVersion: task.version) }) != nil {
                showToast(Toast(message: "将在 \(minutes) 分钟后提醒"))
            }
        }
    }

    func moveToTomorrow(_ task: TodoTask) {
        let p = TaskRescheduling.tomorrow(task)
        Task {
            if await perform("改期", { try await self.client!.updateTask(task.id, p, expectedVersion: task.version) }) != nil {
                showToast(Toast(message: "已改期到明天"))
            }
        }
    }

    func stopSeries(_ id: String) {
        guard canWrite, let client else { return }
        Task {
            do {
                let r = try await client.stopSeries(id)
                seriesById[id] = r.series
                showToast(Toast(message: "已停止系列，取消了 \(r.cancelledTaskIds.count) 个未来实例"))
                await refreshLive()
            } catch {
                showToast(Toast(message: "停止系列失败：\(error.localizedDescription)", isError: true))
            }
        }
    }

    /// Quick add with only a title.
    func quickAdd() {
        let original = quickAddText
        let t = original.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canWrite, !isQuickAdding, !t.isEmpty else { return }
        isQuickAdding = true
        var p = TaskPayload()
        p.set("title", t)
        p.set("scheduledDate", TCDate.todayString())
        Task {
            defer { isQuickAdding = false }
            if await perform("添加", { try await self.client!.createTask(p).task }) != nil {
                if quickAddText == original { quickAddText = "" }
                showToast(Toast(message: "已添加「\(t)」"))
            }
        }
    }

    /// Saves a form draft. Returns an error message to show inline, or nil on success.
    func save(_ draft: TaskDraft) async -> String? {
        guard canWrite, let client else { return "离线状态下无法保存" }
        if let err = draft.validate() { return err }
        do {
            if let id = draft.editingTaskId {
                let t = try await client.updateTask(id, draft.updatePayload(), expectedVersion: draft.version)
                merge(t)
                showToast(Toast(message: "已保存"))
            } else {
                let env = try await client.createTask(draft.createPayload())
                merge(env.task)
                if let s = env.series { seriesById[s.id] = s }
                showToast(Toast(message: env.series == nil ? "已添加「\(env.task.title)」" : "已创建重复任务"))
            }
            savedDraft = nil
            scheduleLiveRefresh()
            return nil
        } catch let e as APIError where e.isVersionConflict {
            await refreshLive()
            return "任务已在别处修改，已刷新，请重新编辑"
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
                showToast(Toast(message: "已导出到 \(name)"))
            } catch {
                showToast(Toast(message: "导出失败：\(error.localizedDescription)", isError: true))
            }
        }
    }

    func requestNotificationAuthorization() async -> String {
        guard let client else { return "未连接" }
        do {
            let a = try await client.requestNotificationAuthorization()
            await loadDoctor()
            return a
        } catch { return error.localizedDescription }
    }

    func sendTestNotification() async -> String {
        guard let client else { return "未连接" }
        do {
            let r = try await client.sendTestNotification()
            return r.ok ? "已提交系统（\(r.channel ?? "?")）" : "发送失败"
        } catch { return error.localizedDescription }
    }

    // MARK: - Navigation

    func showToast(_ t: Toast) {
        toast = t
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: t.undoTaskId == nil ? 5_000_000_000 : 10_000_000_000)
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
    }

    /// Esc: close top layer first; close the panel only from the root (unless pinned).
    func handleEscape() {
        if !routes.isEmpty {
            pop()
        } else if !pinned {
            onClosePanel?()
        }
    }
}
