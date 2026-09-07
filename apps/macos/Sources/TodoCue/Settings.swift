import Foundation

/// User preferences persisted in UserDefaults.
enum Prefs {
    static let notchEnabled = "notchEnabled"
    static let notchDisableInFullscreen = "notchDisableInFullscreen"

    static var isNotchEnabled: Bool {
        get { UserDefaults.standard.object(forKey: notchEnabled) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: notchEnabled) }
    }

    static var disableNotchInFullscreen: Bool {
        get { UserDefaults.standard.object(forKey: notchDisableInFullscreen) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: notchDisableInFullscreen) }
    }
}
