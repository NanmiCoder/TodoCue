import AppKit
import Foundation
import UserNotifications
import TodoCueKit

// TodoCueNotifier — tiny helper that submits UNUserNotifications on behalf of the Node runtime
// and handles notification clicks/actions when relaunched by the system.
//
//   TodoCueNotifier status
//   TodoCueNotifier request
//   TodoCueNotifier deliver --id <id> --title <t> [--body <b>] [--subtitle <s>] [--task-id <id>] [--thread <id>] [--sound]
//   TodoCueNotifier              (launched by macOS for a notification response)
//
// Prints exactly one JSON line on stdout for the command forms.

let categoryId = "TODOCUE_REMINDER"
let actionComplete = "COMPLETE"
let actionSnooze = "SNOOZE"

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
    let complete = UNNotificationAction(identifier: actionComplete, title: "完成", options: [])
    let snooze = UNNotificationAction(identifier: actionSnooze, title: "10 分钟后提醒", options: [])
    let cat = UNNotificationCategory(identifier: categoryId, actions: [complete, snooze], intentIdentifiers: [], options: [])
    center.setNotificationCategories([cat])
}

func requireBundle() {
    if Bundle.main.bundleIdentifier == nil {
        emit(["ok": false, "error": "TodoCueNotifier must run from TodoCueNotifier.app (no bundle identifier)"], exit: 2)
    }
}

func statusPayload(_ settings: UNNotificationSettings) -> [String: Any] {
    ["ok": true, "authorization": authString(settings.authorizationStatus), "alertStyle": alertStyleString(settings.alertStyle)]
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
        let taskId = response.notification.request.content.userInfo["taskId"] as? String
        let action = response.actionIdentifier
        Task {
            await handle(action: action, taskId: taskId)
            completionHandler()
            exit(0)
        }
    }

    func handle(action: String, taskId: String?) async {
        switch action {
        case actionComplete:
            if let taskId, let client = APIClient.fromHome() { _ = try? await client.complete(taskId) }
        case actionSnooze:
            if let taskId, let client = APIClient.fromHome() { _ = try? await client.snooze(taskId, minutes: 10) }
        case UNNotificationDismissActionIdentifier:
            break
        default:
            let url: URL
            if let taskId { url = URL(string: "todocue://task/\(taskId)")! } else { url = URL(string: "todocue://open")! }
            NSWorkspace.shared.open(url)
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
    center.requestAuthorization(options: [.alert, .sound, .badge]) { _, err in
        center.getNotificationSettings { s in
            var p = statusPayload(s)
            if let err { p["error"] = err.localizedDescription }
            emit(p, exit: 0)
        }
    }
    RunLoop.main.run()

case "deliver":
    requireBundle()
    guard let id = args.options["id"], let title = args.options["title"] else {
        emit(["ok": false, "error": "usage: deliver --id <id> --title <title> [--body b] [--subtitle s] [--task-id t] [--thread th] [--sound]"], exit: 2)
    }
    registerCategory(center)
    let content = UNMutableNotificationContent()
    content.title = title
    if let b = args.options["body"] { content.body = b }
    if let s = args.options["subtitle"] { content.subtitle = s }
    if let t = args.options["thread"] { content.threadIdentifier = t }
    if args.flags.contains("sound") { content.sound = .default }
    content.categoryIdentifier = categoryId
    var info: [String: Any] = ["notificationId": id]
    if let taskId = args.options["task-id"] { info["taskId"] = taskId }
    content.userInfo = info
    content.interruptionLevel = .timeSensitive
    let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
    center.getNotificationSettings { settings in
        let denied = settings.authorizationStatus == .denied
        center.removeDeliveredNotifications(withIdentifiers: [id])
        center.add(request) { err in
            if let err {
                emit(["ok": false, "error": err.localizedDescription, "authorization": authString(settings.authorizationStatus)], exit: 1)
            }
            if denied {
                emit(["ok": false, "error": "notifications denied", "authorization": "denied"], exit: 1)
            }
            emit(["ok": true, "channel": "helper", "authorization": authString(settings.authorizationStatus)], exit: 0)
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
