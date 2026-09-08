import TodoCueKit
import SwiftUI

/// The open ring is a cue: one small next step, with room left for the day.
struct CueMark: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @Environment(\.accent) private var accent
    var body: some View {
        ZStack {
            Circle().trim(from: 0.12, to: 0.88)
                .stroke(accent, style: StrokeStyle(lineWidth: 2.4, lineCap: .round))
            Circle().fill(accent).frame(width: 4, height: 4).offset(x: 7)
        }
        .frame(width: 18, height: 18)
        .accessibilityHidden(true)
    }
}

struct DayProgressView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    let completed: Int
    let remaining: Int
    @Environment(\.accent) private var accent
    private var total: Int { max(0, completed) + max(0, remaining) }
    private var progress: Double { total == 0 ? 0 : Double(max(0, completed)) / Double(total) }

    var body: some View {
        HStack(spacing: 7) {
            ZStack {
                Circle().stroke(Color.primary.opacity(0.12), lineWidth: 2)
                Circle().trim(from: 0, to: progress)
                    .stroke(accent, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                if remaining == 0 && completed > 0 {
                    Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(accent)
                }
            }
            .frame(width: 22, height: 22)
            Text(remaining > 0 ? L10n.tr("还剩 \(remaining) 件") : (completed > 0 ? L10n.tr("已清空") : L10n.tr("暂无待办")))
                .font(.system(size: 12, weight: .medium)).monospacedDigit()
                .foregroundStyle(.secondary).contentTransition(.numericText())
        }
        .animation(Theme.interaction, value: progress)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L10n.tr("今日已完成 \(completed) 项，还剩 \(remaining) 项"))
    }
}

struct CueButtonStyle: ButtonStyle {
    var prominent = false
    func makeBody(configuration: Configuration) -> some View {
        ButtonBody(configuration: configuration, prominent: prominent)
    }
    private struct ButtonBody: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
        let configuration: Configuration
        let prominent: Bool
        @Environment(\.accent) private var accent
        @Environment(\.colorScheme) private var scheme
        @Environment(\.isEnabled) private var enabled
        @State private var hovered = false
        var body: some View {
            configuration.label
                .font(.system(size: 12, weight: .medium))
                .padding(.horizontal, 14).frame(minHeight: 32)
                .foregroundStyle(prominent ? (scheme == .dark ? Color.black.opacity(0.88) : .white) : Color.primary)
                .background(prominent ? accent : Color.primary.opacity(hovered ? 0.095 : 0.055), in: Capsule())
                .overlay(Capsule().strokeBorder(Color.white.opacity(prominent ? 0.12 : 0.08), lineWidth: 0.5))
                .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.4)
                .scaleEffect(configuration.isPressed && !Theme.reduceMotion ? 0.97 : 1)
                .animation(Theme.interaction, value: configuration.isPressed)
                .animation(Theme.interaction, value: hovered)
                .onHover { hovered = $0 }
        }
    }
}

struct SurfaceModifier: ViewModifier {
    var radius: CGFloat
    func body(content: Content) -> some View {
        content.background(Theme.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5).allowsHitTesting(false))
    }
}

extension View {
    func cueSurface(radius: CGFloat = 16) -> some View { modifier(SurfaceModifier(radius: radius)) }

    @ViewBuilder func cueScrollEdges() -> some View {
        if #available(macOS 26.0, *) { scrollEdgeEffectStyle(.soft, for: .vertical) }
        else { self }
    }
}

struct EditorSection<Content: View>: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    let title: String
    let icon: String
    let content: Content
    init(title: String, icon: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.icon = icon
        self.content = content()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: icon)
                .font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
                .accessibilityAddTraits(.isHeader)
            content
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cueSurface()
    }
}

/// A stable label/value axis, including while an active field is resized.
struct EditorFieldRow<Content: View>: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    let title: String
    let icon: String
    @ViewBuilder let content: Content

    var body: some View {
        HStack(spacing: 10) {
            Label(title, systemImage: icon)
                .foregroundStyle(.secondary).frame(width: 72, alignment: .leading)
            content.frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: 28)
    }
}
