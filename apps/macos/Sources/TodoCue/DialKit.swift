import AppKit
import CoreText
import SwiftUI
import TodoCueKit

/// Dial: graphite and frosted tiles that float on the desktop, a wide numeral face and one
/// signal orange. Graphite carries what you read at a glance; frost carries what you act on.
/// Motion rules live in docs/design/dial.md.
enum Dial {
    static let orange = Color(red: 0.949, green: 0.416, blue: 0.180) // #F26A2E
    /// Controls and wells sitting on a graphite tile.
    static let raised = Color.white.opacity(0.08)
    static let mutedOnGraphite = Color(red: 0.604, green: 0.616, blue: 0.639) // #9A9DA3
    static let gap: CGFloat = 10
    /// Margin between the shell's edge and the tiles: a little wider than the gaps between tiles,
    /// so the tray reads as a frame around them rather than one more gutter.
    static let shellInset: CGFloat = 14
    /// The shell's corner is concentric with the tiles it holds, one inset further out.
    static var shellRadius: CGFloat { Theme.panelCorner + shellInset }
    static let face = "Michroma"

    static func graphite(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 0.086, green: 0.090, blue: 0.098) : Color(red: 0.110, green: 0.114, blue: 0.125)
    }

    static func frostTint(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 0.165, green: 0.173, blue: 0.188) : Color(red: 0.933, green: 0.941, blue: 0.949)
    }

    /// The wide face is for numbers and short Latin labels only; CJK falls back to the system face.
    static func numeral(_ size: CGFloat) -> Font { .custom(face, size: size) }

    // Motion tokens: every interactive spring in the app is one of these.
    static var snap: Animation { Theme.reduceMotion ? .easeOut(duration: 0.12) : .spring(response: 0.26, dampingFraction: 0.82) }
    static var settle: Animation { Theme.reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.42, dampingFraction: 0.84) }
    static var pop: Animation { Theme.reduceMotion ? .easeOut(duration: 0.12) : .spring(response: 0.34, dampingFraction: 0.58) }

    private static var registered = false
    /// Registers the bundled faces once. A missing file degrades to the system face, never a crash.
    static func registerFonts() {
        guard !registered else { return }
        registered = true
        var directories: [URL] = []
        if let resources = Bundle.main.resourceURL { directories.append(resources.appendingPathComponent("Fonts")) }
        #if DEBUG
        // `swift build` and `swift test` products have no app bundle; read the faces from the package.
        directories.append(URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../Resources/Fonts").standardizedFileURL)
        #endif
        for directory in directories {
            guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { continue }
            let fonts = files.filter { ["ttf", "otf"].contains($0.pathExtension.lowercased()) }
            guard !fonts.isEmpty else { continue }
            for url in fonts { CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil) }
            return
        }
    }
}

/// The tray the tiles sit on, so the panel reads as one object on any wallpaper. On macOS 26 it is
/// the system's Liquid Glass, refracting and tinting with what is behind it; earlier systems get a
/// frosted blur. Both carry the design board's white sweep (bright at the top-left, dipping through
/// the middle) and a double rim: a graphite hairline outside a white lip, so the edge reads over a
/// white page and a dark one alike.
struct DialShell: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Dial.shellRadius, style: .continuous)
        let opaque = Theme.reduceTransparency
        Group {
            if #available(macOS 26.0, *), !opaque {
                ZStack {
                    LiquidGlass(radius: Dial.shellRadius)
                    shape.fill(sweep(opaque: false))
                }
            } else {
                ZStack {
                    if !opaque { BehindWindowBlur(radius: Dial.shellRadius) }
                    shape.fill(sweep(opaque: opaque))
                }
            }
        }
        // Outer hairline in the graphite hue (white on a dark page), then the white lip inside it,
        // brightest along the top edge where the light falls.
        .overlay(shape.strokeBorder(scheme == .dark ? Color.white.opacity(0.22) : Dial.graphite(.light).opacity(0.24), lineWidth: 1))
        .overlay(shape.inset(by: 1).strokeBorder(
            LinearGradient(colors: [Color.white.opacity(scheme == .dark ? 0.2 : 0.95), Color.white.opacity(scheme == .dark ? 0.05 : 0.75)],
                           startPoint: .top, endPoint: .bottom),
            lineWidth: 1.5))
        .allowsHitTesting(false)
    }

    /// Top-left to bottom-right, a little steeper than the diagonal, as on the design board.
    private func sweep(opaque: Bool) -> LinearGradient {
        let stops: [Gradient.Stop]
        if scheme == .dark {
            stops = opaque
                ? [.init(color: Color(red: 0.16, green: 0.17, blue: 0.19), location: 0),
                   .init(color: Color(red: 0.07, green: 0.075, blue: 0.085), location: 1)]
                : [.init(color: Color(red: 0.47, green: 0.50, blue: 0.55).opacity(0.18), location: 0),
                   .init(color: Color(red: 0.03, green: 0.035, blue: 0.045).opacity(0.4), location: 1)]
        } else if opaque {
            stops = [.init(color: .white, location: 0),
                     .init(color: Color(red: 0.937, green: 0.945, blue: 0.953), location: 0.45), // #EFF1F3
                     .init(color: Color(red: 0.969, green: 0.973, blue: 0.976), location: 1)]
        } else {
            stops = [.init(color: Color.white.opacity(0.72), location: 0),
                     .init(color: Color.white.opacity(0.36), location: 0.45),
                     .init(color: Color.white.opacity(0.56), location: 1)]
        }
        return LinearGradient(stops: stops, startPoint: UnitPoint(x: 0.25, y: 0), endPoint: UnitPoint(x: 0.75, y: 1))
    }
}

/// `NSGlassEffectView` clipped to the tray; it follows the system's appearance and accessibility
/// settings (reduced transparency, increased contrast) on its own.
@available(macOS 26.0, *)
private struct LiquidGlass: NSViewRepresentable {
    var radius: CGFloat

    func makeNSView(context: Context) -> NSGlassEffectView {
        let glass = NSGlassEffectView()
        glass.style = .regular
        glass.cornerRadius = radius
        return glass
    }

    func updateNSView(_ glass: NSGlassEffectView, context: Context) {
        glass.cornerRadius = radius
    }
}

enum DialTileStyle { case graphite, frost }

/// One tile of the panel. Graphite always renders its content in the dark scheme; frost follows
/// the system appearance and blurs whatever is behind the window.
struct DialTileModifier: ViewModifier {
    let style: DialTileStyle
    var radius: CGFloat = Theme.panelCorner
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        switch style {
        case .graphite:
            content
                .environment(\.colorScheme, .dark)
                .environment(\.accent, Dial.orange)
                .tint(Dial.orange)
                .background(Dial.graphite(scheme), in: shape)
                .overlay(shape.strokeBorder(Color.white.opacity(scheme == .dark ? 0.08 : 0.05), lineWidth: 0.5).allowsHitTesting(false))
                .clipShape(shape)
        case .frost:
            content
                .background { DialFrost(radius: radius) }
                .overlay(shape.strokeBorder(scheme == .dark ? Color.white.opacity(0.09) : Color.white.opacity(0.8), lineWidth: 0.5)
                    .allowsHitTesting(false))
                .clipShape(shape)
        }
    }
}

extension View {
    func dialTile(_ style: DialTileStyle, radius: CGFloat = Theme.panelCorner) -> some View {
        modifier(DialTileModifier(style: style, radius: radius))
    }

    /// Staggered arrival each time the panel is revealed; `order` is the tile's place from the top.
    func dialReveal(_ order: Int) -> some View { modifier(DialRevealModifier(order: order)) }
}

struct DialFrost: View {
    var radius: CGFloat
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            if !Theme.reduceTransparency { BehindWindowBlur(radius: radius) }
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(Dial.frostTint(scheme).opacity(Theme.reduceTransparency ? 1 : (scheme == .dark ? 0.8 : 0.84)))
        }
        .allowsHitTesting(false)
    }
}

/// Behind-window blur clipped to a tile; the window itself stays transparent between tiles.
struct BehindWindowBlur: NSViewRepresentable {
    var radius: CGFloat

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.blendingMode = .behindWindow
        view.material = .popover
        view.state = .active
        view.wantsLayer = true
        view.layer?.cornerCurve = .continuous
        view.layer?.masksToBounds = true
        view.layer?.cornerRadius = radius
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.layer?.cornerRadius = radius
    }
}

struct DialRevealModifier: ViewModifier {
    @EnvironmentObject private var model: AppModel
    let order: Int
    @State private var shown = true

    func body(content: Content) -> some View {
        // The panel lives on the right edge, so its tiles slide in from that edge, one after another;
        // the window itself only fades, keeping the whole arrival on a single axis.
        content
            .opacity(shown ? 1 : 0)
            .offset(x: shown ? 0 : 18)
            .onChange(of: model.revealTick) { _, _ in
                guard !Theme.reduceMotion else { return }
                var hide = Transaction()
                hide.disablesAnimations = true
                withTransaction(hide) { shown = false }
                DispatchQueue.main.async {
                    withAnimation(.spring(response: 0.4, dampingFraction: 0.9).delay(Double(order) * 0.045)) { shown = true }
                }
            }
    }
}

/// A big wide numeral that rolls when its value changes.
struct DialNumeral: View {
    let value: Int
    var size: CGFloat = 64

    var body: some View {
        Text("\(value)")
            .font(Dial.numeral(size))
            .tracking(-size * 0.03)
            .monospacedDigit()
            .contentTransition(.numericText(value: Double(value)))
            .animation(Dial.settle, value: value)
    }
}

/// Small caps label in the wide face, for short Latin markers such as NEXT.
struct DialMarker: View {
    let text: String
    var color: Color = .secondary

    var body: some View {
        Text(text).font(Dial.numeral(9)).tracking(1.4).foregroundStyle(color)
    }
}

/// Dotted progress ring: the lit dots, the arc and its tip all follow one animatable value.
struct DialGauge: View {
    let completed: Int
    let total: Int
    var diameter: CGFloat = 92
    var showsLabel = true
    @State private var pulse = 0

    private var progress: Double { total == 0 ? 0 : min(1, Double(completed) / Double(total)) }

    var body: some View {
        ZStack {
            GaugeFace(progress: progress, diameter: diameter)
                .animation(Dial.settle, value: progress)
            GaugePulse(trigger: pulse, progress: progress, diameter: diameter)
            if showsLabel {
                Text(total == 0 ? "0" : "\(completed)/\(total)")
                    .font(Dial.numeral(diameter * 0.16))
                    .monospacedDigit()
                    .contentTransition(.numericText(value: Double(completed)))
                    .animation(Dial.settle, value: completed)
            }
        }
        .frame(width: diameter, height: diameter)
        // Only a single finish pulses; a board loading in with several done already does not.
        .onChange(of: completed) { old, new in if new == old + 1 { pulse += 1 } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L10n.tr("今日已完成 \(completed) 项，还剩 \(max(0, total - completed)) 项"))
    }
}

private struct GaugeFace: View, Animatable {
    var progress: Double
    let diameter: CGFloat
    @Environment(\.accent) private var accent

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let radius = size.width / 2 - 4
            let dots = max(24, Int(diameter / 2.3))
            for index in 0..<dots {
                let fraction = Double(index) / Double(dots)
                let angle = -Double.pi / 2 + fraction * 2 * .pi
                let point = CGPoint(x: center.x + radius * cos(angle), y: center.y + radius * sin(angle))
                let lit = fraction < progress
                let r: CGFloat = lit ? 1.5 : 1.1
                context.fill(Path(ellipseIn: CGRect(x: point.x - r, y: point.y - r, width: 2 * r, height: 2 * r)),
                             with: .color(lit ? accent : Color.secondary.opacity(0.55)))
            }
            context.stroke(Path(ellipseIn: CGRect(x: center.x - radius + 8, y: center.y - radius + 8,
                                                  width: 2 * (radius - 8), height: 2 * (radius - 8))),
                           with: .color(Color.primary.opacity(0.07)), lineWidth: 0.5)
            guard progress > 0 else { return }
            let tip = -Double.pi / 2 + progress * 2 * .pi
            let point = CGPoint(x: center.x + radius * cos(tip), y: center.y + radius * sin(tip))
            context.fill(Path(ellipseIn: CGRect(x: point.x - 3, y: point.y - 3, width: 6, height: 6)), with: .color(accent))
        }
    }
}

/// One expanding ring from the gauge tip each time a task is finished.
private struct GaugePulse: View {
    let trigger: Int
    let progress: Double
    let diameter: CGFloat
    @Environment(\.accent) private var accent
    @State private var start: Date?

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 60, paused: start == nil)) { context in
            let elapsed = start.map { context.date.timeIntervalSince($0) } ?? 1
            let p = min(1, elapsed / 0.7)
            let radius = diameter / 2 - 4
            let angle = -Double.pi / 2 + progress * 2 * .pi
            Circle()
                .stroke(accent, lineWidth: 1.5)
                .frame(width: 6 + 18 * p, height: 6 + 18 * p)
                .opacity(p < 1 ? 0.7 * (1 - p) : 0)
                .offset(x: radius * cos(angle), y: radius * sin(angle))
        }
        .allowsHitTesting(false)
        .onChange(of: trigger) { _, _ in
            guard !Theme.reduceMotion else { return }
            start = Date()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) { start = nil }
        }
    }
}

/// Three dots that switch the list; the lit dot slides between them.
struct DialTabDots: View {
    @ObservedObject private var languagePreferences = LanguagePreferences.shared
    @EnvironmentObject var model: AppModel
    @Namespace private var dots

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 6) {
                ForEach(PanelTab.allCases) { tab in
                    let selected = tab == model.tab
                    Button { withAnimation(Dial.snap) { model.tab = tab } } label: {
                        ZStack {
                            Circle().strokeBorder(Color.white.opacity(selected ? 0 : 0.65), lineWidth: 1.4)
                            if selected {
                                Circle().fill(Dial.orange).matchedGeometryEffect(id: "lit", in: dots)
                            }
                            Circle().fill(Color.white).frame(width: selected ? 6 : 4, height: selected ? 6 : 4)
                        }
                        .frame(width: 20, height: 20)
                        .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .help(tab.label)
                    .accessibilityLabel(tab.label)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
            HStack(spacing: 4) {
                ForEach(Array(PanelTab.allCases.enumerated()), id: \.element) { index, tab in
                    if index > 0 { Text("·").foregroundStyle(Dial.mutedOnGraphite.opacity(0.6)) }
                    Button { withAnimation(Dial.snap) { model.tab = tab } } label: {
                        // One weight for every label: a bolder selection would re-measure the row
                        // and nudge its neighbours sideways on every switch.
                        Text(tab.label)
                            .fontWeight(.medium)
                            .foregroundStyle(tab == model.tab ? Color.white : Dial.mutedOnGraphite)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHidden(true)
                }
            }
            .font(.system(size: 11))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.tr("任务视图切换"))
    }
}

/// Pill content: the icon sits in its own circle at the leading edge, the title follows.
struct DialPillLabelStyle: LabelStyle {
    var prominent: Bool
    var hovered: Bool

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 8) {
            ZStack {
                Circle().fill(prominent ? Dial.orange : Color.primary.opacity(0.09))
                configuration.icon
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(prominent ? Color.white : Color.primary)
                    .imageScale(.small)
            }
            .frame(width: 24, height: 24)
            .scaleEffect(hovered && !Theme.reduceMotion ? 1.08 : 1)
            .rotationEffect(.degrees(hovered && !Theme.reduceMotion ? -8 : 0))
            configuration.title
        }
        // The circle hugs the pill's leading edge instead of the text inset.
        .padding(.leading, -9)
    }
}

/// The checkmark as a path, so finishing a task can draw it.
struct CheckmarkShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + rect.width * 0.18, y: rect.minY + rect.height * 0.52))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.42, y: rect.minY + rect.height * 0.74))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.82, y: rect.minY + rect.height * 0.28))
        return path
    }
}

/// The small "today" time a row shows on its trailing edge, in the wide face.
struct DialTimeBadge: View {
    let task: TodoTask

    static func text(for task: TodoTask) -> String? {
        guard task.status == .todo, let at = task.scheduledAt, let date = TCDate.parse(at),
              Calendar.current.isDateInToday(date) else { return nil }
        return TCDate.time(date)
    }

    var body: some View {
        if let text = Self.text(for: task) {
            Text(text)
                .font(Dial.numeral(10))
                .monospacedDigit()
                .foregroundStyle(task.isOverdue ? Theme.overdue : Color.primary.opacity(0.75))
                .padding(.top, 6)
                .accessibilityHidden(true)
        }
    }
}
