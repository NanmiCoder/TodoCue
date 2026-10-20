import AppKit
import Combine
import Foundation
import AppleSyncKit
import TodoCueKit

/// The desktop app's Apple sync: the SwiftUI app's controller, fed by this process's own runtime
/// link and driven over stdin/stdout by the Tauri host.
@MainActor
final class SyncHelper {
    let sync: AppleSyncController
    private let link: RuntimeLink
    private let write: (String) -> Void
    private var lastStatus: HelperStatus?
    private var statusQueued = false
    private var cancellables: Set<AnyCancellable> = []

    init(sync: AppleSyncController, link: RuntimeLink, write: @escaping (String) -> Void) {
        self.sync = sync
        self.link = link
        self.write = write
        sync.backend = { [weak link] in link?.online == true ? link?.client : nil }
        sync.todoTasks = { [weak link] in link?.online == true ? link?.tasks : nil }
        link.onChange = { [weak self] in
            self?.sync.scheduleSync()
            self?.queueStatus()
        }
        sync.objectWillChange.sink { [weak self] _ in self?.queueStatus() }.store(in: &cancellables)
        // The desktop app refuses to start beside the SwiftUI app, but not the other way round. Two
        // engines writing one apple-sync.json would lose links and duplicate items, so stand aside.
        sync.pauseReason = {
            Self.legacyClientRunning() ? L10n.tr("旧版 TodoCue 正在运行，Apple 同步已暂停，退出旧版后会自动继续。") : nil
        }
        let workspace = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
            workspace.publisher(for: name)
                .filter { ($0.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier == "com.todocue.app" }
                .sink { [weak self] _ in self?.sync.scheduleSync() }
                .store(in: &cancellables)
        }
    }

    /// The SwiftUI client: same bundle identifier as the desktop app, but its executable is "TodoCue".
    static func legacyClientRunning() -> Bool {
        NSRunningApplication.runningApplications(withBundleIdentifier: "com.todocue.app")
            .contains { $0.executableURL?.lastPathComponent == "TodoCue" }
    }

    func start() {
        sync.startHeartbeat()
        link.start()
        sendStatus(force: true)
        sync.scheduleSync()
    }

    /// `objectWillChange` fires before the change lands; read the state on the next turn.
    private func queueStatus() {
        guard !statusQueued else { return }
        statusQueued = true
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                self?.statusQueued = false
                self?.sendStatus()
            }
        }
    }

    private func sendStatus(force: Bool = false) {
        let status = HelperStatus(sync, connected: link.online)
        guard force || status != lastStatus else { return }
        lastStatus = status
        write(HelperOutput.status(status).line)
    }

    func handle(_ line: String) async {
        guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        let command: HelperCommand
        do {
            command = try HelperCommand.parse(line)
        } catch {
            // Without a readable id there is nobody to answer; say so on stderr for the host's log.
            FileHandle.standardError.write(Data("TodoCueAppleSync: unreadable command: \(line)\n".utf8))
            return
        }
        let (message, error) = await perform(command)
        if let id = command.id { write(HelperOutput.result(id: id, message: message, error: error).line) }
        sendStatus()
    }

    private func perform(_ command: HelperCommand) async -> (message: String?, error: String?) {
        switch command.command {
        case .status:
            sendStatus(force: true)
            return (nil, nil)
        case .refreshAccess:
            sync.refreshAccess()
            return (nil, nil)
        case .syncNow:
            await sync.syncNow()
            return (sync.lastError, nil)
        case .setLanguage:
            guard let language = command.language else { return (nil, "language is required") }
            L10n.languageOverride = AppLanguage(desktopSetting: language)
            return (nil, nil)
        case .setEnabled, .removeData, .openPrivacySettings:
            guard let kind = command.kind else { return (nil, "kind is required") }
            switch command.command {
            case .setEnabled:
                guard let enabled = command.enabled else { return (nil, "enabled is required") }
                return (await sync.setEnabled(kind, enabled), nil)
            case .removeData:
                return (await sync.removeData(kind), nil)
            default:
                sync.openPrivacySettings(kind)
                return (nil, nil)
            }
        }
    }
}
