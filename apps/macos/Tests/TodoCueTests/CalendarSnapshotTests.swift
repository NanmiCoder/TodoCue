import XCTest
import SwiftUI
import AppKit
import TodoCueKit
@testable import TodoCue

/// Opt-in offscreen render of the calendar route, driven by `scripts/calendar-screenshots.mjs`
/// against a disposable runtime. Uses `ImageRenderer` rather than a real panel so verification
/// never opens a window, activates the app, or borrows the pointer.
final class CalendarSnapshotTests: XCTestCase {
    struct Fixture: Decodable {
        let language: String
        let today: String
        let connection: ConnectionInfo
    }

    @MainActor func testRenderCalendarScenes() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let manifest = env["TODOCUE_CALENDAR_FIXTURES"], let output = env["TODOCUE_CALENDAR_OUTPUT"],
              let home = env["TODOCUE_HOME"], home.contains("todocue-calendar-") else {
            throw XCTSkip("Opt-in: run scripts/calendar-screenshots.mjs against a disposable runtime")
        }
        _ = NSApplication.shared
        let fixtures = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: URL(fileURLWithPath: manifest)))
        let originalLanguage = LanguagePreferences.shared.language
        let originalAppearance = NSApp.appearance
        defer { LanguagePreferences.shared.language = originalLanguage; NSApp.appearance = originalAppearance }
        try FileManager.default.createDirectory(at: URL(fileURLWithPath: output), withIntermediateDirectories: true)

        for fixture in fixtures {
            // Two scenes producing the same pixels means one of them did not take effect.
            var seen: Set<Data> = []
            let language = try XCTUnwrap(AppLanguage(rawValue: fixture.language))
            LanguagePreferences.shared.language = language
            let model = AppModel(client: APIClient(connection: fixture.connection))
            await model.refreshAll()
            XCTAssertGreaterThan(model.allTasks.count, 3)
            XCTAssertFalse(model.seriesById.isEmpty, "recurring fixtures must reach the projection")

            let twoMonthsOut = CivilDate.addingMonths(2, to: fixture.today)
            let scenes: [(String, CGSize, ColorScheme, () -> Void)] = [
                // Not a calendar scene: the task views and the calendar spans now share one
                // segmented control, so this guards the existing tab bar against that refactor.
                ("today-tabs", CGSize(width: 340, height: 680), .light, { model.routes = []; model.tab = .today }),
                ("month-today", CGSize(width: 340, height: 680), .light, { model.showCalendar() }),
                ("month-today-dark", CGSize(width: 340, height: 680), .dark, { model.showCalendar() }),
                ("month-narrow", CGSize(width: 300, height: 680), .light, { model.showCalendar() }),
                ("month-collapsed-short", CGSize(width: 300, height: 360), .light, { model.showCalendar() }),
                ("month-ghosts", CGSize(width: 340, height: 680), .light, {
                    model.showCalendar()
                    model.setCalendar(anchor: twoMonthsOut, selected: twoMonthsOut)
                }),
                ("month-past", CGSize(width: 340, height: 680), .light, {
                    model.showCalendar()
                    model.setCalendar(selected: CivilDate.adding(-6, to: fixture.today))
                }),
                ("week", CGSize(width: 340, height: 680), .light, {
                    model.showCalendar()
                    model.setCalendar(span: .week)
                }),
                ("week-dark", CGSize(width: 300, height: 680), .dark, {
                    model.showCalendar()
                    model.setCalendar(span: .week)
                }),
            ]

            // ImageRenderer lays ScrollView out at zero height, so the agenda and the week list
            // are rendered again outside their scroll containers to check the rows themselves.
            let bare: [(String, CGSize, ColorScheme, String)] = [
                ("agenda-today", CGSize(width: 340, height: 420), .light, fixture.today),
                ("agenda-today-dark", CGSize(width: 300, height: 420), .dark, fixture.today),
                ("agenda-ghost", CGSize(width: 340, height: 420), .light, CivilDate.addingMonths(2, to: fixture.today)),
                ("agenda-past", CGSize(width: 340, height: 420), .light, CivilDate.adding(-6, to: fixture.today)),
                ("agenda-deadline", CGSize(width: 340, height: 420), .light, CivilDate.adding(5, to: fixture.today)),
                // Before every fixture and before the series start dates: a genuinely empty day.
                ("agenda-empty", CGSize(width: 300, height: 200), .light, CivilDate.adding(-60, to: fixture.today)),
            ]
            for (name, size, scheme, date) in bare {
                model.routes = []
                model.showCalendar()
                model.setCalendar(anchor: date, selected: date)
                try await Task.sleep(nanoseconds: 400_000_000)
                let appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)!
                NSApp.appearance = appearance
                var image: NSImage?
                appearance.performAsCurrentDrawingAppearance {
                    let renderer = ImageRenderer(content:
                        DayAgendaList(date: date)
                            .environmentObject(model)
                            .todoCueAccent()
                            .environment(\.colorScheme, scheme)
                            .padding(10)
                            .frame(width: size.width, alignment: .leading)
                            .background(scheme == .dark ? Color(white: 0.12) : Color(white: 0.96)))
                    renderer.scale = 2
                    image = renderer.nsImage
                }
                let rendered = try XCTUnwrap(image, name)
                let rep = try XCTUnwrap(NSBitmapImageRep(data: rendered.tiffRepresentation!))
                let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                try png.write(to: URL(fileURLWithPath: output)
                    .appendingPathComponent("\(fixture.language)-\(name).png"))
            }

            // The week span stacks the same blocks; render them outside the scroll view too.
            for (name, size, scheme) in [("week-bare", CGSize(width: 340, height: 700), ColorScheme.light),
                                         ("week-bare-dark", CGSize(width: 300, height: 700), ColorScheme.dark)] {
                model.routes = []
                model.showCalendar()
                model.setCalendar(span: .week)
                try await Task.sleep(nanoseconds: 400_000_000)
                let days = CalendarRange.days(span: .week, anchor: model.calendarAnchor,
                                              firstWeekday: model.calendarFirstWeekday)
                let appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)!
                NSApp.appearance = appearance
                var image: NSImage?
                appearance.performAsCurrentDrawingAppearance {
                    let renderer = ImageRenderer(content:
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(days, id: \.self) { DayAgendaList(date: $0, hidesWhenEmpty: true) }
                        }
                        .environmentObject(model)
                        .todoCueAccent()
                        .environment(\.colorScheme, scheme)
                        .padding(10)
                        .frame(width: size.width, alignment: .leading)
                        .background(scheme == .dark ? Color(white: 0.12) : Color(white: 0.96)))
                    renderer.scale = 2
                    image = renderer.nsImage
                }
                let rendered = try XCTUnwrap(image, name)
                let rep = try XCTUnwrap(NSBitmapImageRep(data: rendered.tiffRepresentation!))
                let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                try png.write(to: URL(fileURLWithPath: output)
                    .appendingPathComponent("\(fixture.language)-\(name).png"))
            }

            for (name, size, scheme, setup) in scenes {
                model.routes = []
                setup()
                // `showCalendar()` once left the span untouched, so every month scene silently
                // rendered a week and the evidence was worthless. Never let that be silent again.
                if name != "today-tabs" {
                    XCTAssertEqual(model.calendarSpan, name.hasPrefix("week") ? .week : .month, name)
                }
                // History lands through an async fetch; give it a beat before rendering.
                try await Task.sleep(nanoseconds: 400_000_000)
                let appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)!
                NSApp.appearance = appearance
                var image: NSImage?
                appearance.performAsCurrentDrawingAppearance {
                    let renderer = ImageRenderer(content:
                        PanelRootView()
                            .environmentObject(model)
                            .environment(\.colorScheme, scheme)
                            .frame(width: size.width, height: size.height)
                            .background(scheme == .dark ? Color(white: 0.12) : Color(white: 0.96)))
                    renderer.scale = 2
                    image = renderer.nsImage
                }
                let rendered = try XCTUnwrap(image, name)
                let rep = try XCTUnwrap(NSBitmapImageRep(data: rendered.tiffRepresentation!))
                let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                XCTAssertTrue(seen.insert(png).inserted, "\(name) is byte-identical to an earlier scene")
                try png.write(to: URL(fileURLWithPath: output)
                    .appendingPathComponent("\(fixture.language)-\(name).png"))
            }
        }
    }
}
