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

/// Compact "done / total" read-out with a small dotted gauge, used where the header numeral is absent.
struct DayProgressView: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    let completed: Int
    let remaining: Int
    private var total: Int { max(0, completed) + max(0, remaining) }

    var body: some View {
        HStack(spacing: 7) {
            DialGauge(completed: max(0, completed), total: total, diameter: 24, showsLabel: false)
            Text(remaining > 0 ? L10n.tr("还剩 \(remaining) 件") : (completed > 0 ? L10n.tr("已清空") : L10n.tr("暂无待办")))
                .font(.system(size: 12, weight: .medium)).monospacedDigit()
                .foregroundStyle(.secondary).contentTransition(.numericText())
        }
        .animation(Theme.interaction, value: remaining)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L10n.tr("今日已完成 \(completed) 项，还剩 \(remaining) 项"))
    }
}

/// Dial pills. Prominent inverts the surface it sits on (graphite on frost, light on graphite)
/// and puts its icon in an orange disc; the quiet pill is an outline.
struct CueButtonStyle: ButtonStyle {
    var prominent = false
    func makeBody(configuration: Configuration) -> some View {
        ButtonBody(configuration: configuration, prominent: prominent)
    }
    private struct ButtonBody: View {
        @ObservedObject private var languagePreferences = LanguagePreferences.shared
        let configuration: Configuration
        let prominent: Bool
        @Environment(\.colorScheme) private var scheme
        @Environment(\.isEnabled) private var enabled
        @State private var hovered = false

        private var fill: Color {
            if prominent { return scheme == .dark ? Color(white: 0.95) : Color(red: 0.110, green: 0.114, blue: 0.125) }
            return Color.primary.opacity(configuration.isPressed ? 0.12 : (hovered ? 0.07 : 0))
        }
        private var foreground: Color {
            if prominent { return scheme == .dark ? Color(red: 0.110, green: 0.114, blue: 0.125) : .white }
            return .primary
        }

        var body: some View {
            configuration.label
                .labelStyle(DialPillLabelStyle(prominent: prominent, hovered: hovered && enabled))
                .font(.system(size: 12, weight: prominent ? .semibold : .medium))
                .lineLimit(1)
                .padding(.horizontal, 14).frame(minHeight: prominent ? 34 : 32)
                .foregroundStyle(foreground)
                .background(Capsule().fill(fill))
                .overlay(Capsule().strokeBorder(prominent ? Color.clear : Color.primary.opacity(hovered ? 0.3 : 0.2), lineWidth: 1))
                .contentShape(Capsule())
                .opacity(enabled ? 1 : 0.4)
                .scaleEffect(configuration.isPressed && !Theme.reduceMotion ? 0.96 : 1)
                .animation(Dial.snap, value: configuration.isPressed)
                .animation(Dial.snap, value: hovered)
                .onHover { hovered = $0 }
        }
    }
}

/// The panel's segmented control: a capsule track with a selection that slides between segments.
/// Shared by the task views and the calendar spans so the two cannot drift apart.
struct SegmentedCapsule<Item: Identifiable & Equatable>: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    private let items: [Item]
    private let selected: Item
    private let title: (Item) -> String
    private let select: (Item) -> Void
    /// Segments divide the width equally when true, and hug their labels when false.
    private let fills: Bool
    private let height: CGFloat
    private let fontSize: CGFloat
    private let trackPadding: CGFloat
    private let label: String
    @Namespace private var slider
    @Environment(\.colorScheme) private var scheme
    private var selectedFill: Color { scheme == .dark ? Color(white: 0.95) : Color(red: 0.110, green: 0.114, blue: 0.125) }
    private var selectedText: Color { scheme == .dark ? Color(red: 0.110, green: 0.114, blue: 0.125) : .white }

    init(items: [Item], selected: Item, title: @escaping (Item) -> String, select: @escaping (Item) -> Void,
         fills: Bool = true, height: CGFloat = 32, fontSize: CGFloat = 12, trackPadding: CGFloat = 3,
         label: String) {
        self.items = items; self.selected = selected; self.title = title; self.select = select
        self.fills = fills; self.height = height; self.fontSize = fontSize
        self.trackPadding = trackPadding; self.label = label
    }

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items) { item in
                let isSelected = item == selected
                Button { withAnimation(Dial.snap) { select(item) } } label: {
                    // Same weight selected or not, so the sliding capsule never chases a resizing label.
                    Text(title(item))
                        .font(.system(size: fontSize, weight: .semibold))
                        .frame(maxWidth: fills ? .infinity : nil)
                        .padding(.horizontal, fills ? 0 : 8)
                        .frame(height: height)
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .foregroundStyle(isSelected ? selectedText : Color.secondary)
                .background {
                    // The selection is the inverted Dial pill and slides between segments.
                    if isSelected {
                        Capsule().fill(selectedFill)
                            .matchedGeometryEffect(id: "selected-segment", in: slider)
                    }
                }
                .accessibilityLabel(title(item))
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(trackPadding)
        .background(Color.primary.opacity(0.06), in: Capsule())
        .accessibilityElement(children: .contain).accessibilityLabel(label)
    }
}

/// A compact, tactile chip for interactive metadata selection.
struct AttributeChip<Control: View>: View {
    var isActive: Bool = false
    var tint: Color? = nil
    var onClear: (() -> Void)? = nil
    @ViewBuilder var control: () -> Control
    @State private var hovered = false
    @Environment(\.accent) private var accent
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 5) {
            control()
            if isActive, let onClear {
                Button(action: onClear) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .help(L10n.tr("清除"))
                .accessibilityLabel(L10n.tr("清除"))
            }
        }
        .padding(.horizontal, 9)
        .frame(height: 26)
        .background {
            Capsule()
                .fill(isActive
                      ? (tint ?? accent).opacity(scheme == .dark ? 0.16 : 0.10)
                      : Color.primary.opacity(hovered ? 0.07 : 0.035))
        }
        .overlay {
            Capsule()
                .strokeBorder(isActive
                              ? (tint ?? accent).opacity(scheme == .dark ? 0.35 : 0.28)
                              : (scheme == .dark ? Color.white.opacity(0.08) : Color.black.opacity(0.05)),
                              lineWidth: 0.5)
        }
        .contentShape(Capsule())
        .onHover { hovered = $0 }
        .animation(Theme.interaction, value: hovered)
        .animation(Theme.interaction, value: isActive)
    }
}

/// Pure label: clear actions live beside the control, never inside a Button or Menu.
struct AttributeChipLabel: View {
    let title: String
    var icon: String? = nil
    var isActive = false
    var tint: Color? = nil
    @Environment(\.accent) private var accent

    var body: some View {
        HStack(spacing: 5) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: isActive ? .semibold : .medium))
                    .foregroundStyle(isActive ? (tint ?? accent) : .secondary)
            }
            Text(title)
                .font(.system(size: 11, weight: isActive ? .medium : .regular))
                .foregroundStyle(isActive ? Color.primary : .secondary)
                .lineLimit(1).truncationMode(.middle)
        }
        .frame(height: 26)
        .contentShape(Rectangle())
    }
}

struct SurfaceModifier: ViewModifier {
    var radius: CGFloat
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        // An inset well inside a tile: flat, no shadow — depth belongs to the tiles themselves.
        content.background(scheme == .dark ? Color.white.opacity(0.05) : Color.white.opacity(0.62),
                           in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(scheme == .dark ? Color.white.opacity(0.07) : Color.white.opacity(0.9), lineWidth: 0.5).allowsHitTesting(false))
    }
}

extension View {
    func cueSurface(radius: CGFloat = 20) -> some View { modifier(SurfaceModifier(radius: radius)) }

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
