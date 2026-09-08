import SwiftUI
import AppKit
import TodoCueKit

enum Theme {
    static let panelWidth: CGFloat = 340
    static let panelMinWidth: CGFloat = 300
    static let panelMaxWidth: CGFloat = 600
    static var panelHeight: CGFloat {
        #if DEBUG
        if let raw = ProcessInfo.processInfo.environment["TODOCUE_PREVIEW_HEIGHT"], let value = Double(raw) {
            return CGFloat(max(360, min(680, value)))
        }
        #endif
        return 680
    }
    static let panelMargin: CGFloat = 12
    static let panelCorner: CGFloat = 28
    static let notchExpandedWidth: CGFloat = 560
    static let notchMaxHeight: CGFloat = 560
    static let notchMaxRows = 5
    static let notchSlack: CGFloat = 10
    static let notchWingWidth: CGFloat = 44
    static let notchCorner: CGFloat = 24
    static let notchCollapsedCorner: CGFloat = 10
    static let overdue = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 1, green: 0.57, blue: 0.45, alpha: 1)
            : NSColor(red: 0.7, green: 0.2, blue: 0.13, alpha: 1)
    })

    static func accent(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 0.48, green: 0.85, blue: 0.74) : Color(red: 0.03, green: 0.43, blue: 0.35)
    }

    static let surface = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(white: 1, alpha: 0.055) : NSColor(white: 1, alpha: 0.72)
    })
    static let insetSurface = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(white: 1, alpha: 0.065) : NSColor(white: 1, alpha: 0.55)
    })
    // Keep the dark glass shell quiet without creating an opaque inner well.
    static let shellTint = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(white: 0, alpha: 0.32) : .clear
    })
    static var interaction: Animation { reduceMotion ? .linear(duration: 0.01) : .spring(response: 0.26, dampingFraction: 0.86) }

    static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    static var reduceTransparency: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency }

    static var expand: Animation {
        reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.32, dampingFraction: 0.86)
    }
    static var collapse: Animation {
        reduceMotion ? .easeInOut(duration: 0.15) : .easeOut(duration: 0.18)
    }
    static let dragSettleDuration: TimeInterval = 0.22
    static var dragShift: Animation {
        reduceMotion ? .linear(duration: 0.01) : .timingCurve(0.25, 0.1, 0.25, 1, duration: 0.20)
    }
    static var dragSettle: Animation {
        reduceMotion ? .linear(duration: 0.01) : .timingCurve(0.2, 0.8, 0.2, 1, duration: dragSettleDuration)
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

/// Consistent pointer target and feedback for the panel's utility buttons.
struct QuietIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        IconBody(configuration: configuration)
    }

    private struct IconBody: View {
        let configuration: ButtonStyle.Configuration
        @Environment(\.isEnabled) private var enabled
        @State private var hovering = false
        var body: some View {
            configuration.label
                .font(.system(size: 13, weight: .medium))
                .frame(width: 30, height: 30)
                .contentShape(Circle())
                .background(Color.primary.opacity(configuration.isPressed ? 0.10 : (hovering ? 0.06 : 0)),
                            in: Circle())
                .opacity(enabled ? 1 : 0.4)
                .scaleEffect(configuration.isPressed && !Theme.reduceMotion ? 0.94 : 1)
                .animation(Theme.interaction, value: configuration.isPressed)
                .onHover { hovering = $0 }
        }
    }
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
