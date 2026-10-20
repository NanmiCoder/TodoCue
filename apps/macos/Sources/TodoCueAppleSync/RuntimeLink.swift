import Foundation
import TodoCueKit

/// The helper's own connection to the runtime: it reads `connection.json` (the desktop WebView never
/// holds the token, but a native helper may, like the CLI), follows the event stream and keeps the
/// latest board's todo tasks — the same inputs the SwiftUI app handed its sync controller.
@MainActor
final class RuntimeLink {
    private(set) var client: APIClient?
    /// A board has been read on the current connection and the stream has not dropped since.
    private(set) var online = false
    /// The todo tasks of the latest board; nil until one has arrived.
    private(set) var tasks: [TodoTask]?
    /// Called when `online` or `tasks` changes.
    var onChange: (() -> Void)?

    private let home: URL
    private var connection: ConnectionInfo?
    private var sse: SSEClient?
    private var sseTask: Task<Void, Never>?
    private var watcher: DispatchSourceFileSystemObject?
    private var pollTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var refreshAgain = false

    init(home: URL = TodoCueHome.directory) {
        self.home = home
    }

    func start() {
        watch()
        load()
    }

    private func load() {
        let info = (try? Data(contentsOf: home.appendingPathComponent("connection.json")))
            .flatMap { try? JSONDecoder().decode(ConnectionInfo.self, from: $0) }
        guard info != connection || client == nil else { return }
        connection = info
        sse?.stop()
        sseTask?.cancel()
        refreshTask?.cancel()
        refreshTask = nil
        let wasOnline = online
        online = false
        tasks = nil
        if wasOnline { onChange?() }
        guard let info else {
            client = nil
            schedulePoll()
            return
        }
        let client = APIClient(connection: info)
        self.client = client
        let sse = SSEClient(client: client)
        self.sse = sse
        let stream = sse.start()
        sseTask = Task { [weak self] in
            for await item in stream {
                guard let self else { return }
                switch item {
                case .state(.connected), .event:
                    // Every event may have moved a task; a reconnect may have missed some.
                    self.refresh()
                case .state(.disconnected):
                    if self.online {
                        self.online = false
                        self.onChange?()
                    }
                case .state(.connecting):
                    break
                }
            }
        }
    }

    /// No `connection.json` yet (the runtime is still starting): look again shortly, in case the
    /// directory watcher could not be set up.
    private func schedulePoll() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard let self, !Task.isCancelled else { return }
            if self.connection == nil {
                if self.watcher == nil { self.watch() }
                self.load()
            }
        }
    }

    /// Runtime restarts rewrite `connection.json` with a new token and pid.
    private func watch() {
        guard watcher == nil else { return }
        let fd = open(home.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete],
                                                               queue: .main)
        source.setEventHandler { [weak self] in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                MainActor.assumeIsolated { self?.load() }
            }
        }
        source.setCancelHandler { close(fd) }
        source.resume()
        watcher = source
    }

    /// Bursts of events (a bulk agent write, sync's own writes) share one board request in flight
    /// and at most one queued behind it.
    private func refresh() {
        if refreshTask != nil { refreshAgain = true; return }
        refreshTask = Task { [weak self] in
            guard let self else { return }
            repeat {
                self.refreshAgain = false
                try? await Task.sleep(nanoseconds: 150_000_000)
                if Task.isCancelled { return }
                await self.loadBoard()
            } while self.refreshAgain && !Task.isCancelled
            // A cancelled refresh was already replaced by `load`; clearing would drop the new one.
            if !Task.isCancelled { self.refreshTask = nil }
        }
    }

    private func loadBoard() async {
        guard let client else { return }
        do {
            let board = try await client.board()
            // The connection changed while the request was out: its answer belongs to the old runtime.
            guard client.token == self.client?.token, !Task.isCancelled else { return }
            let changed = !online || tasks != board.all
            online = true
            tasks = board.all
            if changed { onChange?() }
        } catch {
            guard client.token == self.client?.token else { return }
            if online {
                online = false
                onChange?()
            }
            FileHandle.standardError.write(Data("TodoCueAppleSync: board unavailable: \(error.localizedDescription)\n".utf8))
            // The stream may stay up while the board fails; do not wait for the next event to retry.
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard let self, client.token == self.client?.token, !self.online else { return }
                self.refresh()
            }
        }
    }
}
