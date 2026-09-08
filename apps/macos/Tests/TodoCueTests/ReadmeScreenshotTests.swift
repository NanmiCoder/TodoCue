import XCTest
import AppKit
import ScreenCaptureKit
import TodoCueKit
@testable import TodoCue

/// Opt-in capture of real panels backed by disposable runtime databases.
/// Run via scripts/readme-screenshots.mjs; never connects to the normal home.
final class ReadmeScreenshotTests: XCTestCase {
    struct Fixture: Decodable {
        let language: String
        let connection: ConnectionInfo
        let detailTaskId: String
        let quickTitle: String
        let draftTitle: String
        let draftNotes: String
        let project: String
    }

    @MainActor func testCaptureReadmePanels() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let manifest = env["TODOCUE_README_FIXTURES"], let output = env["TODOCUE_README_OUTPUT"],
              let home = env["TODOCUE_HOME"], home.contains("todocue-readme-") else {
            throw XCTSkip("Opt-in: requires fresh README fixture databases and an output directory")
        }
        let fixtures = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: URL(fileURLWithPath: manifest)))
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        NSApp.finishLaunching()
        let originalLanguage = LanguagePreferences.shared.language
        let originalAppearance = NSApp.appearance
        defer { LanguagePreferences.shared.language = originalLanguage; NSApp.appearance = originalAppearance }
        for fixture in fixtures {
            let language = try XCTUnwrap(AppLanguage(rawValue: fixture.language))
            LanguagePreferences.shared.language = language
            let model = AppModel(client: APIClient(connection: fixture.connection))
            await model.refreshAll()
            XCTAssertTrue(model.canWrite)
            XCTAssertGreaterThan(model.allTasks.count, 3)
            let suite = "todocue-readme-window-" + UUID().uuidString
            let defaults = UserDefaults(suiteName: suite)!
            defaults.set(420.0, forKey: "panelWidth")
            let backdrop = NSWindow(contentRect: NSScreen.main!.frame, styleMask: .borderless, backing: .buffered, defer: false)
            backdrop.isReleasedWhenClosed = false
            backdrop.level = .normal
            let panel = SidePanelController(model: model, defaults: defaults)
            defer { panel.window.orderOut(nil); backdrop.orderOut(nil); defaults.removePersistentDomain(forName: suite) }
            let folder = URL(fileURLWithPath: output).appendingPathComponent(language == .english ? "en" : "zh-CN")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

            for scene in ["today-light", "task-detail-dark", "quick-add-light", "task-form-light"] {
                NSApp.appearance = NSAppearance(named: scene.hasSuffix("dark") ? .darkAqua : .aqua)
                model.routes = []; model.tab = .today; model.quickAddText = ""
                switch scene {
                case "task-detail-dark": model.routes = [.detail(fixture.detailTaskId)]
                case "quick-add-light": model.quickAddText = fixture.quickTitle
                case "task-form-light":
                    var draft = TaskDraft()
                    draft.title = fixture.draftTitle; draft.notes = fixture.draftNotes
                    draft.project = fixture.project; draft.priority = .medium; draft.estimate = "25"
                    model.routes = [.form(draft)]
                default: break
                }
                backdrop.backgroundColor = scene.hasSuffix("dark") ? NSColor(white: 0.09, alpha: 1) : .white
                backdrop.orderFrontRegardless()
                panel.show(focusInput: true)
                NSApp.activate(ignoringOtherApps: true)
                // Keep the caret and focus ring out of editorial screenshots.
                try await Task.sleep(nanoseconds: 1_000_000_000)
                panel.window.makeFirstResponder(nil)
                panel.window.contentView?.layoutSubtreeIfNeeded()
                try await Task.sleep(nanoseconds: 500_000_000)
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                let window = try XCTUnwrap(content.windows.first { $0.windowID == CGWindowID(panel.window.windowNumber) })
                let background = try XCTUnwrap(content.windows.first { $0.windowID == CGWindowID(backdrop.windowNumber) })
                let display = try XCTUnwrap(content.displays.first { $0.frame.contains(window.frame.origin) })
                // Capture the panel over our own neutral backdrop, excluding every other
                // window (including the computer-use cursor overlay). This preserves glass.
                let filter = SCContentFilter(display: display, including: [background, window])
                let config = SCStreamConfiguration()
                config.width = Int(panel.window.frame.width * 2)
                config.height = Int(panel.window.frame.height * 2)
                config.sourceRect = CGRect(x: window.frame.minX - display.frame.minX, y: window.frame.minY - display.frame.minY,
                                           width: window.frame.width, height: window.frame.height)
                config.showsCursor = false
                config.ignoreShadowsSingleWindow = true
                let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
                XCTAssertEqual(image.width, 840)
                XCTAssertGreaterThanOrEqual(image.height, 1200)
                let png = try XCTUnwrap(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
                try png.write(to: folder.appendingPathComponent(scene + ".png"))
            }
        }
    }
}
