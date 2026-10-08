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

        private var foregroundColor: Color {
            if prominent {
                return scheme == .dark ? Color.black.opacity(0.9) : .white
            }
            return Color.primary
        }

        @ViewBuilder
        private var backgroundView: some View {
            if prominent {
                LinearGradient(
                    colors: [accent, accent.opacity(0.88)],
                    startPoint: .top, endPoint: .bottom
                )
                .clipShape(Capsule())
            } else {
                Capsule().fill(Color.primary.opacity(hovered ? 0.08 : 0.04))
            }
        }

        private var borderStrokeColor: Color {
            if scheme == .dark {
                return Color.white.opacity(prominent ? 0.2 : 0.08)
            } else {
                return prominent ? Color.white.opacity(0.25) : Color.black.opacity(0.06)
            }
        }

        var body: some View {
            configuration.label
                .font(.system(size: 12, weight: prominent ? .semibold : .medium))
                .padding(.horizontal, 14).frame(minHeight: 32)
                .foregroundStyle(foregroundColor)
                .background(backgroundView)
                .overlay(Capsule().strokeBorder(borderStrokeColor, lineWidth: 0.5))
                .shadow(color: prominent ? accent.opacity(scheme == .dark ? 0.35 : 0.22) : Color.black.opacity(0.02), radius: prominent ? 5 : 2, y: prominent ? 2 : 1)
                .opacity(enabled ? (configuration.isPressed ? 0.82 : 1) : 0.4)
                .scaleEffect(configuration.isPressed && !Theme.reduceMotion ? 0.96 : (hovered && !Theme.reduceMotion ? 1.01 : 1))
                .animation(Theme.interaction, value: configuration.isPressed)
                .animation(Theme.interaction, value: hovered)
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
                Button { withAnimation(Theme.interaction) { select(item) } } label: {
                    Text(title(item))
                        .font(.system(size: fontSize, weight: isSelected ? .semibold : .medium))
                        .frame(maxWidth: fills ? .infinity : nil)
                        .padding(.horizontal, fills ? 0 : 8)
                        .frame(height: height)
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .foregroundStyle(isSelected ? Color.primary : .secondary)
                .background {
                    if isSelected {
                        Capsule().fill(Theme.surface)
                            .overlay(Capsule().strokeBorder(Color.white.opacity(0.35), lineWidth: 0.5))
                            .shadow(color: .black.opacity(0.06), radius: 4, y: 1.5)
                            .matchedGeometryEffect(id: "selected-segment", in: slider)
                    }
                }
                .accessibilityLabel(title(item))
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(trackPadding)
        .background(Color.primary.opacity(0.04), in: Capsule())
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
        content.background(Theme.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(scheme == .dark ? Color.white.opacity(0.09) : Color.black.opacity(0.055), lineWidth: 0.5).allowsHitTesting(false))
            .shadow(color: Color.black.opacity(scheme == .dark ? 0.2 : 0.035), radius: 6, y: 2)
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
