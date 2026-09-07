import SwiftUI
import AppKit
import TodoCueKit

enum Theme {
    static let panelWidth: CGFloat = 380
    static let panelHeight: CGFloat = 680
    static let panelMargin: CGFloat = 12
    static let panelCorner: CGFloat = 22
    static let notchExpandedWidth: CGFloat = 440
    static let notchMaxHeight: CGFloat = 300

    static func accent(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(nsColor: .systemMint) : Color(red: 0.0, green: 0.55, blue: 0.45)
    }

    static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    static var reduceTransparency: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency }

    static var expand: Animation {
        reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.32, dampingFraction: 0.86)
    }
    static var collapse: Animation {
        reduceMotion ? .easeInOut(duration: 0.15) : .easeOut(duration: 0.18)
    }
    static var listChange: Animation {
        reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.3, dampingFraction: 0.9)
    }
}

struct AccentColorKey: EnvironmentKey { static let defaultValue: Color = Color(nsColor: .systemMint) }
extension EnvironmentValues {
    var accent: Color {
        get { self[AccentColorKey.self] }
        set { self[AccentColorKey.self] = newValue }
    }
}

/// Applies the mint accent based on the current color scheme.
struct AccentModifier: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        content.environment(\.accent, Theme.accent(scheme)).tint(Theme.accent(scheme))
    }
}

extension View {
    func todoCueAccent() -> some View { modifier(AccentModifier()) }
}

extension Priority {
    var symbol: String? {
        switch self {
        case .none: return nil
        case .low: return "arrow.down"
        case .medium: return "equal"
        case .high: return "exclamationmark"
        }
    }
    var color: Color {
        switch self {
        case .none: return .secondary
        case .low: return .secondary
        case .medium: return .orange
        case .high: return .red
        }
    }
}
