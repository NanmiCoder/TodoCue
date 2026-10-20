import CryptoKit
import Foundation
import TodoCueKit

/// The two sync switches. Off until the user turns one on and grants access.
public enum AppleSyncPreferences {
    /// The domain the SwiftUI app (bundle `com.todocue.app`) has always written the switches to.
    static let appDomain = "com.todocue.app"

    /// True for the real data (`~/.todocue`), false for an isolated `TODOCUE_HOME`.
    public static func isDefaultHome(_ home: URL = TodoCueHome.directory) -> Bool {
        let real = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".todocue").standardizedFileURL
        return home.standardizedFileURL.path == real.path
    }

    /// Where the switches live. The real data keeps the keys v0.5 wrote into the app's own domain, so a
    /// switch stays on across the SwiftUI app, the desktop helper and a rollback. An isolated home gets
    /// a domain of its own: a test runtime turning sync off, or removing its data, must not touch the
    /// switches of the real data.
    public static func store(home: URL = TodoCueHome.directory, bundleIdentifier: String? = Bundle.main.bundleIdentifier) -> UserDefaults {
        suiteName(home: home, bundleIdentifier: bundleIdentifier).flatMap(UserDefaults.init(suiteName:)) ?? .standard
    }

    /// The suite `store` opens, or nil for the running app's own domain (`suiteName` may not name it).
    static func suiteName(home: URL, bundleIdentifier: String?) -> String? {
        guard isDefaultHome(home) else {
            // A digest, not the path: a suite name becomes a file name, so it cannot carry a "/".
            let digest = SHA256.hash(data: Data(home.standardizedFileURL.path.utf8))
            return "com.todocue.applesync." + digest.prefix(12).map { String(format: "%02x", $0) }.joined()
        }
        return bundleIdentifier == appDomain ? nil : appDomain
    }

    public static func isEnabled(_ kind: AppleSyncKind, in defaults: UserDefaults) -> Bool {
        defaults.object(forKey: key(kind)) as? Bool ?? false
    }

    public static func setEnabled(_ on: Bool, for kind: AppleSyncKind, in defaults: UserDefaults) {
        defaults.set(on, forKey: key(kind))
    }

    static func key(_ kind: AppleSyncKind) -> String {
        kind == .event ? "appleCalendarSyncEnabled" : "appleRemindersSyncEnabled"
    }
}
