import Foundation
import AppleSyncKit
import TodoCueKit

/// One line on stdin from the desktop host. `id` comes back on the matching `result` line.
struct HelperCommand: Decodable, Equatable {
    enum Name: String, Decodable {
        case status, setEnabled, syncNow, removeData, refreshAccess, openPrivacySettings, setLanguage
    }

    var id: Int?
    var command: Name
    var kind: AppleSyncKind?
    var enabled: Bool?
    /// The desktop app's language setting: "en" or "zh-CN".
    var language: String?

    static func parse(_ line: String) throws -> HelperCommand {
        try JSONDecoder().decode(HelperCommand.self, from: Data(line.utf8))
    }
}

/// What the settings page shows. Sent whenever it changes, and on request.
struct HelperStatus: Encodable, Equatable {
    struct Container: Encodable, Equatable {
        var title: String
        var sourceTitle: String
        var isICloud: Bool
    }

    struct Channel: Encodable, Equatable {
        var enabled: Bool
        /// "notDetermined", "writeOnly", "granted" or "denied".
        var access: String
        /// A switch being flipped (permission prompt, first round): the UI holds it still.
        var changing: Bool
        var container: Container?
    }

    var event: Channel
    var reminder: Channel
    var syncing: Bool
    var lastSyncAt: String?
    var lastError: String?
    /// A board has been read from the runtime; sync cannot run before that.
    var connected: Bool

    @MainActor
    init(_ sync: AppleSyncController, connected: Bool) {
        func channel(_ kind: AppleSyncKind) -> Channel {
            let enabled = sync.isEnabled(kind)
            return Channel(enabled: enabled, access: (sync.access[kind] ?? .notDetermined).rawValue,
                           changing: sync.changing.contains(kind),
                           // A container is only shown for a channel that is on, as in the SwiftUI settings.
                           container: enabled ? sync.containers[kind].map {
                               Container(title: $0.title, sourceTitle: $0.sourceTitle, isICloud: $0.isICloud)
                           } : nil)
        }
        event = channel(.event)
        reminder = channel(.reminder)
        syncing = sync.isSyncing
        lastSyncAt = sync.lastSyncAt.map(TCDate.iso)
        lastError = sync.lastError
        self.connected = connected
    }
}

/// One line on stdout to the desktop host.
enum HelperOutput: Encodable, Equatable {
    case status(HelperStatus)
    /// `message` is what the SwiftUI settings showed under the switches (nil when all went well);
    /// `error` means the command itself could not be understood.
    case result(id: Int, message: String?, error: String?)

    private enum Keys: String, CodingKey { case type, status, id, message, error }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .status(let status):
            try c.encode("status", forKey: .type)
            try c.encode(status, forKey: .status)
        case .result(let id, let message, let error):
            try c.encode("result", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(message, forKey: .message)
            try c.encode(error, forKey: .error)
        }
    }

    var line: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = (try? encoder.encode(self)) ?? Data(#"{"type":"invalid"}"#.utf8)
        return String(decoding: data, as: UTF8.self)
    }
}

extension AppLanguage {
    /// The desktop app stores "en" or "zh-CN".
    init(desktopSetting: String) {
        self = desktopSetting.lowercased().hasPrefix("en") ? .english : .chinese
    }
}
