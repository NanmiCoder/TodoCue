import AppKit
import Foundation
import UserNotifications
import TodoCueKit

// TodoCueNotifier — tiny helper that submits UNUserNotifications on behalf of the Node runtime
// and handles notification clicks/actions when relaunched by the system.
//
//   TodoCueNotifier status
//   TodoCueNotifier request
//   TodoCueNotifier open-settings
//   TodoCueNotifier deliver --id <id> --title <t> [--body <b>] [--subtitle <s>] [--task-id <id>] [--thread <id>] [--sound] [--home <dir>]
//   TodoCueNotifier              (launched by macOS for a notification response)
//
// Prints exactly one JSON line on stdout for the command forms.
//
// Exit codes: 0 success, 1 `deliver` failure, 2 usage/bundle error.
// `request` always exits 0, including when the app is already denied: macOS only ever
// prompts once per bundle, so a denial is reported in the body as
// {"ok":false,"authorization":"denied","needsSystemSettings":true} rather than as an
// error. A non-zero exit would be turned into an exception by the runtime's helper
// bridge, which keeps only the `error` field and drops the rest of the payload.

let categoryId = "TODOCUE_REMINDER"
let periodicCategoryId = "TODOCUE_PERIODIC"
let actionComplete = "COMPLETE"
let actionSnooze = "SNOOZE"

/// Bundle identifier macOS files our notification authorization under; also the row the
/// user has to enable by hand after a denial. Fixed in scripts/build-macos.sh.
let notifierBundleId = "com.todocue.notifier"

struct Args {
    var command: String?
    var options: [String: String] = [:]
    var flags: Set<String> = []

    init(_ argv: [String]) {
        var i = 0
        while i < argv.count {
            let a = argv[i]
            if a.hasPrefix("--") {
                let key = String(a.dropFirst(2))
                if i + 1 < argv.count, !argv[i + 1].hasPrefix("--") {
                    options[key] = argv[i + 1]; i += 2
                } else {
                    flags.insert(key); i += 1
                }
            } else {
                if command == nil { command = a }
                i += 1
            }
        }
    }
}

func emit(_ obj: [String: Any], exit code: Int32) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data("{\"ok\":false}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(code)
}

func authString(_ s: UNAuthorizationStatus) -> String {
    switch s {
    case .authorized: return "authorized"
    case .provisional: return "provisional"
    case .denied: return "denied"
    case .notDetermined: return "notDetermined"
    case .ephemeral: return "authorized"
    @unknown default: return "unknown"
    }
}

func alertStyleString(_ s: UNAlertStyle) -> String {
    switch s {
    case .none: return "none"
    case .banner: return "banner"
    case .alert: return "alert"
    @unknown default: return "unknown"
    }
}

func registerCategory(_ center: UNUserNotificationCenter) {
    let complete = UNNotificationAction(identifier: actionComplete, title: L10n.tr("完成"), options: [])
    let snooze = UNNotificationAction(identifier: actionSnooze, title: L10n.tr("10 分钟后提醒"), options: [])
    let cat = UNNotificationCategory(identifier: categoryId, actions: [complete, snooze], intentIdentifiers: [], options: [])
    let periodicComplete = UNNotificationAction(identifier: actionComplete, title: L10n.tr("完成本次"), options: [])
    let periodic = UNNotificationCategory(identifier: periodicCategoryId, actions: [periodicComplete, snooze], intentIdentifiers: [], options: [])
    center.setNotificationCategories([cat, periodic])
}

func requireBundle() {
    if Bundle.main.bundleIdentifier == nil {
        emit(["ok": false, "error": "TodoCueNotifier must run from TodoCueNotifier.app (no bundle identifier)"], exit: 2)
    }
}

func settingString(_ s: UNNotificationSetting) -> String {
    switch s {
    case .enabled: return "enabled"
    case .disabled: return "disabled"
    case .notSupported: return "notSupported"
    @unknown default: return "unknown"
    }
}

/// Plain-string view of the live settings; the decision rules live in TodoCueKit
/// (`NotificationSnapshot`) so they are unit tested.
func snapshot(_ s: UNNotificationSettings) -> NotificationSnapshot {
    NotificationSnapshot(
        authorization: authString(s.authorizationStatus),
        alertStyle: alertStyleString(s.alertStyle),
        alertSetting: settingString(s.alertSetting),
        notificationCenterSetting: settingString(s.notificationCenterSetting),
        soundSetting: settingString(s.soundSetting))
}

func statusPayload(_ settings: UNNotificationSettings) -> [String: Any] {
    var p = snapshot(settings).statusFields
    p["ok"] = true
    return p
}

/// Opens System Settings › Notifications, ideally with our own row revealed.
///
/// This is the only way back once macOS has recorded a denial: `requestAuthorization`
/// never shows a prompt again for a given bundle, so the user has to flip the switch by
/// hand. Tries the modern extension pane first and degrades to the legacy pane id.
func openNotificationSettings() -> (ok: Bool, url: String) {
    let candidates = [
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(notifierBundleId)",
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
        "x-apple.systempreferences:com.apple.preference.notifications?id=\(notifierBundleId)",
    ]
    for candidate in candidates where launch(candidate) { return (true, candidate) }
    // Report no URL rather than the first candidate: none of them actually opened, and
    // naming one would read as if it had.
    return (false, "")
}

/// Shells out to `/usr/bin/open` instead of `NSWorkspace.shared.open`: both route through
/// LaunchServices, but `open` returns a real exit status. The helper is spawned directly by
/// the runtime (never via LaunchServices) and may be running outside a GUI session, so an
/// honest failure signal matters more here than avoiding the subprocess.
private func launch(_ url: String) -> Bool {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    proc.arguments = [url]
    proc.standardOutput = FileHandle.nullDevice
    proc.standardError = FileHandle.nullDevice
    do {
        try proc.run()
        proc.waitUntilExit()
        return proc.terminationStatus == 0
    } catch {
        return false
    }
}

final class ResponseDelegate: NSObject, UNUserNotificationCenterDelegate {
    var handled = false

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        handled = true
        let info = response.notification.request.content.userInfo
        let taskId = info["taskId"] as? String
        let action = response.actionIdentifier
        // The data directory that issued this notification (`deliver --home`). macOS relaunches
        // us without arguments, so userInfo is the only place it survives.
        let home = info["home"] as? String
        let periodicId = info["periodicId"] as? String
        let occurrenceId = info["occurrenceId"] as? String
        let round = info["round"] as? Int
        Task {
            if let periodicId {
                await handlePeriodic(action: action, id: periodicId, occurrenceId: occurrenceId, round: round, home: home)
            } else { await handle(action: action, taskId: taskId, home: home) }
            completionHandler()
            exit(0)
        }
    }

    func handlePeriodic(action: String, id: String, occurrenceId: String?, round: Int?, home: String?) async {
        switch action {
        case actionComplete, actionSnooze:
            guard let occurrenceId, let round, let client = APIClient.fromHome(home) else {
                // Runtime offline or no connection.json: same visible fallback as a failed action.
                if let url = URL(string: "todocue://periodic/\(id)") { NSWorkspace.shared.open(url) }
                return
            }
            do {
                _ = try await client.periodicAction(id, action: action == actionComplete ? "complete" : "snooze",
                    occurrenceId: occurrenceId, round: round, idempotencyKey: "notification:\(occurrenceId):\(round):\(action)")
            } catch {
                // Make a failed or stale action visible rather than silently claiming completion.
                if let url = URL(string: "todocue://periodic/\(id)") { NSWorkspace.shared.open(url) }
            }
        case UNNotificationDismissActionIdentifier: break
        default:
            if let url = URL(string: "todocue://periodic/\(id)") { NSWorkspace.shared.open(url) }
        }
    }

    func handle(action: String, taskId: String?, home: String?) async {
        switch action {
        case actionComplete, actionSnooze:
            // Never swallow a failure: if the runtime is offline or rejects the call, open the
            // task in the panel so the user can finish it by hand (same as periodic reminders).
            var done = false
            if let taskId, let client = APIClient.fromHome(home) {
                do {
                    if action == actionComplete { _ = try await client.complete(taskId) }
                    else { _ = try await client.snooze(taskId, minutes: 10) }
                    done = true
                } catch {
                    done = false
                }
            }
            if !done, let url = NotificationFallback.taskURL(taskId: taskId) { NSWorkspace.shared.open(url) }
        case UNNotificationDismissActionIdentifier:
            break
        default:
            if let url = NotificationFallback.taskURL(taskId: taskId) { NSWorkspace.shared.open(url) }
        }
    }
}

let args = Args(Array(CommandLine.arguments.dropFirst()))
let center = UNUserNotificationCenter.current()

switch args.command {
case "status":
    requireBundle()
    center.getNotificationSettings { s in emit(statusPayload(s), exit: 0) }
    RunLoop.main.run()

case "request":
    requireBundle()
    registerCategory(center)
    // Ask only when macOS can still show a prompt. After a denial every call returns
    // immediately without any UI, which is what made the Settings button look dead.
    center.getNotificationSettings { current in
        switch current.authorizationStatus {
        case .notDetermined:
            center.requestAuthorization(options: [.alert, .sound, .badge]) { _, err in
                center.getNotificationSettings { s in
                    var p = statusPayload(s)
                    let denied = s.authorizationStatus == .denied
                    p["ok"] = !denied
                    p["needsSystemSettings"] = denied
                    if let err { p["error"] = err.localizedDescription }
                    emit(p, exit: 0)
                }
            }
        case .denied:
            // No point calling requestAuthorization: macOS has already recorded a decision
            // and will never ask again. Point the caller at System Settings instead.
            var p = statusPayload(current)
            p["ok"] = false
            p["needsSystemSettings"] = true
            p["error"] = "notifications denied; macOS will not prompt again"
            emit(p, exit: 0)
        default:
            // Already authorized/provisional/ephemeral — nothing left to ask for.
            var p = statusPayload(current)
            p["needsSystemSettings"] = false
            emit(p, exit: 0)
        }
    }
    RunLoop.main.run()

case "open-settings":
    requireBundle()
    let result = openNotificationSettings()
    emit(["ok": result.ok, "url": result.url], exit: 0)

case "deliver":
    requireBundle()
    guard let id = args.options["id"], let title = args.options["title"] else {
        emit(["ok": false, "error": "usage: deliver --id <id> --title <title> [--body b] [--subtitle s] [--task-id t] [--thread th] [--sound] [--home dir]"], exit: 2)
    }
    registerCategory(center)
    let content = UNMutableNotificationContent()
    content.title = title
    if let b = args.options["body"] { content.body = b }
    if let s = args.options["subtitle"] { content.subtitle = s }
    if let t = args.options["thread"] { content.threadIdentifier = t }
    if args.flags.contains("sound") { content.sound = .default }
    content.categoryIdentifier = args.options["periodic-id"] == nil ? categoryId : periodicCategoryId
    var info: [String: Any] = ["notificationId": id]
    if let taskId = args.options["task-id"] { info["taskId"] = taskId }
    if let periodicId = args.options["periodic-id"] { info["periodicId"] = periodicId }
    if let occurrenceId = args.options["occurrence-id"] { info["occurrenceId"] = occurrenceId }
    if let value = args.options["round"], let round = Int(value) { info["round"] = round }
    // Remember which data directory issued this cue: the click relaunches us without arguments.
    if let home = args.options["home"], !home.isEmpty { info["home"] = home }
    content.userInfo = info
    // `.timeSensitive` needs the Time Sensitive Notifications entitlement, which this helper
    // does not have (ad-hoc / Developer ID without it): macOS silently treats it as `.active`,
    // while the level reads as if it broke through Focus. Use `.active` for every cue.
    content.interruptionLevel = .active
    let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
    center.getNotificationSettings { settings in
        let snap = snapshot(settings)
        // Refuse before add(): the system accepts requests it will never show (notDetermined,
        // denied, style None), and a false ok:true makes the runtime mark the cue as sent.
        if let reason = snap.deliveryError {
            var p = snap.statusFields
            p["ok"] = false
            p["error"] = reason
            emit(p, exit: 1)
        }
        center.removeDeliveredNotifications(withIdentifiers: [id])
        center.add(request) { err in
            if let err {
                var p = snap.statusFields
                p["ok"] = false
                p["error"] = err.localizedDescription
                emit(p, exit: 1)
            }
            var p = snap.statusFields
            p["ok"] = true
            p["channel"] = "helper"
            emit(p, exit: 0)
        }
    }
    RunLoop.main.run()

case nil:
    // Launched by the system to deliver a notification response (or the user double-clicked us).
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = ResponseDelegate()
    center.delegate = delegate
    registerCategory(center)
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
        if !delegate.handled { exit(0) }
    }
    app.run()

default:
    emit(["ok": false, "error": "unknown command \(args.command ?? "")"], exit: 2)
}
