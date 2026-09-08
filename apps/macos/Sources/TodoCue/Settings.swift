import Foundation

/// User preferences persisted in UserDefaults.
enum Prefs {
    private static let panelWidthKey = "panelWidth"

    static func panelWidth(in defaults: UserDefaults = .standard) -> CGFloat {
        let saved = defaults.object(forKey: panelWidthKey) as? Double
        return PanelGeometry.width(saved.map { CGFloat($0) } ?? Theme.panelWidth)
    }

    static func savePanelWidth(_ width: CGFloat, in defaults: UserDefaults = .standard) {
        defaults.set(Double(PanelGeometry.width(width)), forKey: panelWidthKey)
    }

    static func panelHeight(in defaults: UserDefaults = .standard) -> CGFloat {
        let saved = defaults.object(forKey: "panelHeight") as? Double
        return PanelGeometry.height(saved.map { CGFloat($0) } ?? Theme.panelHeight)
    }

    static func savePanelHeight(_ height: CGFloat, in defaults: UserDefaults = .standard) {
        defaults.set(Double(PanelGeometry.height(height)), forKey: "panelHeight")
    }

    static let notchEnabled = "notchEnabled"
    static let notchDisableInFullscreen = "notchDisableInFullscreen"
    static let notchSummary = "notchShowsSummary"

    static var isNotchEnabled: Bool {
        get { UserDefaults.standard.object(forKey: notchEnabled) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: notchEnabled) }
    }

    static var disableNotchInFullscreen: Bool {
        get { UserDefaults.standard.object(forKey: notchDisableInFullscreen) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: notchDisableInFullscreen) }
    }

    /// Collapsed notch shows the cue mark and today's remaining count beside the camera.
    static var notchShowsSummary: Bool {
        get { UserDefaults.standard.object(forKey: notchSummary) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: notchSummary) }
    }
}
