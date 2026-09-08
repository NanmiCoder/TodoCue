import XCTest
import SwiftUI
import AppKit
import TodoCueKit
@testable import TodoCue

/// Opt-in offscreen render of the panel's read surfaces, driven by `scripts/panel-screenshots.mjs`
/// against a disposable runtime. Uses `ImageRenderer` rather than a real panel so verification
/// never opens a window, activates the app, or borrows the pointer.
final class PanelSnapshotTests: XCTestCase {
    struct Fixture: Decodable {
        let language: String
        let today: String
        let connection: ConnectionInfo
        /// Planned in 2020, completed today — the case that forces completion-time grouping.
        let staleTitle: String
        let searchTerm: String
    }

    @MainActor private func wait(upTo seconds: Double, until done: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !done(), Date() < deadline { try await Task.sleep(nanoseconds: 30_000_000) }
    }

    @MainActor func testRenderPanelScenes() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let manifest = env["TODOCUE_PANEL_FIXTURES"], let output = env["TODOCUE_PANEL_OUTPUT"],
              let home = env["TODOCUE_HOME"], home.contains("todocue-panel-") else {
            throw XCTSkip("Opt-in: run scripts/panel-screenshots.mjs against a disposable runtime")
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
                ("completed", CGSize(width: 340, height: 680), .light, { model.showCompleted() }),
                ("completed-dark", CGSize(width: 300, height: 680), .dark, { model.showCompleted() }),
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
                // Mid-drag: a task lifted out of tomorrow, hovering two days later.
                ("month-dragging", CGSize(width: 340, height: 680), .light, {
                    model.showCalendar()
                    if let task = model.allTasks.first(where: { $0.planDate == CivilDate.adding(1, to: fixture.today) }) {
                        _ = model.beginTaskDrag(task, surface: .calendar, group: CivilDate.adding(1, to: fixture.today))
                        model.dropTarget = TaskDropTarget(surface: .calendar,
                                                          group: CivilDate.adding(3, to: fixture.today), beforeId: nil)
                    }
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

            // The completed history end to end against the real runtime: proving the fetch worked
            // matters more than the picture, since ImageRenderer cannot draw the scroll container.
            model.routes = []
            model.showCompleted()
            try await wait(upTo: 5) { !model.isLoadingCompleted && !model.completedTasks.isEmpty }
            XCTAssertGreaterThanOrEqual(model.completedTasks.count, 5, "the history must actually load")
            XCTAssertFalse(model.completedLoadFailed)
            XCTAssertTrue(model.completedTasks.allSatisfy { $0.status == .done })
            // Newest first, which is what makes `limit` mean "the most recent N".
            let stamps = model.completedTasks.map { $0.completedAt ?? $0.updatedAt }
            XCTAssertEqual(stamps, stamps.sorted(by: >), "the runtime already orders these")
            // Searching narrows the loaded set.
            XCTAssertEqual(CompletedHistory.matching(model.completedTasks, query: fixture.staleTitle).count, 1)

            for (name, size, scheme, text) in [("completed-list", CGSize(width: 340, height: 700), ColorScheme.light, ""),
                                               ("completed-list-dark", CGSize(width: 300, height: 700), ColorScheme.dark, ""),
                                               ("completed-search", CGSize(width: 340, height: 320), ColorScheme.light, fixture.searchTerm)] {
                let appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)!
                NSApp.appearance = appearance
                var image: NSImage?
                appearance.performAsCurrentDrawingAppearance {
                    let renderer = ImageRenderer(content:
                        CompletedList(query: text)
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
                            ForEach(days, id: \.self) { DayAgendaList(date: $0, isWeekBlock: true) }
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
                // `showCalendar()` once left the span untouched, so every month scene silently
                // rendered a week and the evidence was worthless. Never let that be silent again.
                if name.hasPrefix("month") || name.hasPrefix("week") {
                    XCTAssertEqual(model.calendarSpan, name.hasPrefix("week") ? .week : .month, name)
                }
                // History lands through an async fetch; give it a beat before rendering.
                try await Task.sleep(nanoseconds: 700_000_000)
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
