import Foundation

/// Pure decision logic behind `TodoCueNotifier status / request / deliver`.
///
/// The helper maps `UNNotificationSettings` into this plain-string snapshot so the rules
/// ("may we claim a notification was delivered?", "is it actually visible?") can be unit
/// tested without touching UserNotifications, which would need a bundle and could prompt.
public struct NotificationSnapshot: Equatable, Sendable {
    /// `authorized` | `provisional` | `denied` | `notDetermined` | `unknown`
    public var authorization: String
    /// `none` | `banner` | `alert` | `unknown`
    public var alertStyle: String
    /// Each setting: `enabled` | `disabled` | `notSupported` | `unknown`
    public var alertSetting: String
    public var notificationCenterSetting: String
    public var soundSetting: String

    public init(authorization: String, alertStyle: String, alertSetting: String,
                notificationCenterSetting: String, soundSetting: String) {
        self.authorization = authorization
        self.alertStyle = alertStyle
        self.alertSetting = alertSetting
        self.notificationCenterSetting = notificationCenterSetting
        self.soundSetting = soundSetting
    }

    public var isAuthorized: Bool { authorization == "authorized" || authorization == "provisional" }

    /// A banner/alert can appear: the style is not `none` and the alert switch is not off.
    /// A `notSupported`/`unknown` alert switch defers to the style alone.
    public var bannerVisible: Bool {
        (alertStyle == "banner" || alertStyle == "alert") && alertSetting != "disabled"
    }

    public var notificationCenterVisible: Bool { notificationCenterSetting == "enabled" }

    /// The user can actually see a notification we post: authorized (or provisional) and at
    /// least one of banner/alert or Notification Center is on. `notDetermined`/`denied` are
    /// never visible.
    public var visible: Bool { isAuthorized && (bannerVisible || notificationCenterVisible) }

    /// JSON-ready fields shared by `status` and `request`. Field names are a contract with
    /// the runtime (packages/engine/src/notifier.ts); do not rename.
    public var statusFields: [String: Any] {
        [
            "authorization": authorization,
            "alertStyle": alertStyle,
            "alertSetting": alertSetting,
            "notificationCenterSetting": notificationCenterSetting,
            "soundSetting": soundSetting,
            "visible": visible,
        ]
    }

    /// Why `deliver` must not report success, or nil when submitting is worthwhile.
    /// Texts are shown to the user as-is by the runtime/UI.
    ///
    /// `notDetermined` used to fall through as success: `UNUserNotificationCenter.add` accepts
    /// the request but macOS never shows it, so the reminder was recorded as sent and lost.
    public var deliveryError: String? {
        switch authorization {
        case "denied":
            return "notifications denied; allow TodoCue in System Settings > Notifications"
        case "notDetermined":
            return "notifications not authorized yet (notDetermined); open TodoCue settings and allow notifications"
        case "authorized", "provisional":
            return visible ? nil
                : "notification style is set to None (no banner and Notification Center is off); set TodoCue to Banners or Alerts in System Settings > Notifications"
        default:
            // Unknown future status: let the system decide rather than block delivery.
            return nil
        }
    }
}

/// Where a notification click should send the user when the in-place action could not run.
public enum NotificationFallback {
    public static func taskURL(taskId: String?) -> URL? {
        if let taskId, !taskId.isEmpty { return URL(string: "todocue://task/\(taskId)") }
        return URL(string: "todocue://open")
    }
}
