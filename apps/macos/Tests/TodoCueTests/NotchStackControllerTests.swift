import XCTest
import AppKit
import TodoCueKit
@testable import TodoCue

private final class StackAPIProtocol: URLProtocol {
    static var respond: ((StackAPIProtocol) -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.respond?(self) }
    override func stopLoading() {}
    func reply(_ object: Any, status: Int = 200) {
        let data = try! JSONSerialization.data(withJSONObject: object)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
}

/// The real controller with a real notch window: reminders stay, stack, merge and leave on answers.
@MainActor
final class NotchStackControllerTests: XCTestCase {
    private var savedFullscreenPreference = true

    // Whether the frontmost app happens to be full screen is the machine's business, not the test's.
    override func setUp() async throws {
        savedFullscreenPreference = Prefs.disableNotchInFullscreen
        Prefs.disableNotchInFullscreen = false
    }

    override func tearDown() async throws {
        Prefs.disableNotchInFullscreen = savedFullscreenPreference
    }

    private func model() -> AppModel {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StackAPIProtocol.self]
        return AppModel(client: APIClient(baseURL: URL(string: "http://fixture.invalid")!, token: "test",
                                          session: URLSession(configuration: config)))
    }

    private func rule(_ id: String, occurrence: String? = nil, revision: Int = 1, result: String = "pending",
                      delivery: String = "displayed") throws -> PeriodicReminder {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            try CueStackTests.rule(id, occurrence: occurrence, delivery: delivery, result: result,
                                   at: TCDate.iso(Date())))) as! [String: Any]
        object["revision"] = revision
        return try JSONDecoder().decode(PeriodicReminder.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func requireNotch() throws {
        #if arch(x86_64)
        // GitHub's Intel VM has a screen but no Metal target; SwiftUI's animated notch drawing aborts there.
        if ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" {
            throw XCTSkip("Native animated notch requires a usable GPU; unavailable on GitHub's Intel VM")
        }
        #endif
        guard Prefs.isNotchEnabled, !NSScreen.screens.isEmpty else { throw XCTSkip("Notch display disabled or unavailable") }
    }

    private func started(_ model: AppModel, featureDuration: TimeInterval = 0.3) -> NotchController {
        _ = NSApplication.shared
        let controller = NotchController(model: model)
        controller.featureDuration = featureDuration
        controller.start()
        return controller
    }

    private func settle(_ seconds: Double = 0.2) async throws {
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    func testAWaitingRuleComesBackAndStaysAfterTheFeaturedCardRests() async throws {
        try requireNotch()
        let model = model()
        model.periodicReminders = [try rule("p_a")]; model.periodicLoaded = true
        let controller = started(model); defer { controller.stop() }
        XCTAssertEqual(controller.state.entries.map(\.key), ["periodic:p_a"], "restored from the runtime's open occurrence")
        XCTAssertTrue(controller.state.stackShown)
        XCTAssertEqual(controller.state.featuredKey, "periodic:p_a")
        // The card rests as a row after the featured time. Nothing retires it.
        try await settle(1.6)
        XCTAssertNil(controller.state.featuredKey)
        XCTAssertEqual(controller.state.entries.count, 1)
        XCTAssertTrue(controller.state.stackShown)
        XCTAssertNotNil(controller.activeCue)
    }

    func testASecondReminderJoinsTheStackInsteadOfBeingRefused() async throws {
        try requireNotch()
        let model = model()
        model.periodicReminders = [try rule("p_a")]; model.periodicLoaded = true
        let controller = started(model); defer { controller.stop() }
        let offered = try rule("p_b", delivery: "offered")
        var claimed = try JSONSerialization.jsonObject(with: JSONEncoder().encode(try rule("p_b", delivery: "claimed"))) as! [String: Any]
        var occurrence = claimed["currentOccurrence"] as! [String: Any]
        occurrence["claimedAt"] = TCDate.iso(Date()); occurrence["channel"] = "notch"
        claimed["currentOccurrence"] = occurrence; claimed["revision"] = 2
        StackAPIProtocol.respond = { request in
            if request.request.url?.path.hasSuffix("/claim") == true { request.reply(["reminder": claimed]) }
            else { request.reply(["reminder": claimed]) }
        }
        defer { StackAPIProtocol.respond = nil }
        model.periodicReminders.append(offered)
        model.onPeriodicCue?(offered)
        try await settle(0.6)
        XCTAssertEqual(Set(controller.state.entries.map(\.key)), ["periodic:p_a", "periodic:p_b"])
        XCTAssertEqual(controller.state.entries.first?.key, "periodic:p_a", "arrival order holds")
        let window = try XCTUnwrap(NSApp.windows.compactMap { $0 as? NotchWindow }.first { $0.isVisible && $0.frame.width > 300 })
        XCTAssertFalse(window.canBecomeKey, "the stack never takes the keyboard")
        XCTAssertEqual(window.frame.width, 460, accuracy: 1)
    }

    func testTheSameRuleComingRoundAgainMergesAndAnAnswerElsewhereRemovesIt() async throws {
        try requireNotch()
        let model = model()
        model.periodicReminders = [try rule("p_a", occurrence: "po_1", revision: 1)]; model.periodicLoaded = true
        let controller = started(model); defer { controller.stop() }
        XCTAssertEqual(controller.state.entries.first?.repeats, 1)
        model.mergePeriodic(try rule("p_a", occurrence: "po_2", revision: 2))
        try await settle()
        XCTAssertEqual(controller.state.entries.count, 1, "one row per rule")
        XCTAssertEqual(controller.state.entries.first?.repeats, 2)
        model.mergePeriodic(try rule("p_a", occurrence: "po_2", revision: 3, result: "completed"))
        try await settle(0.8)
        XCTAssertTrue(controller.state.entries.isEmpty)
        XCTAssertFalse(controller.state.stackShown)
    }

    func testFoldingKeepsTheCountAndANewArrivalUnfolds() async throws {
        try requireNotch()
        let model = model()
        model.periodicReminders = [try rule("p_a", occurrence: "po_1", revision: 1)]; model.periodicLoaded = true
        let controller = started(model); defer { controller.stop() }
        controller.state.onStackCollapse?()
        try await settle()
        XCTAssertFalse(controller.state.stackShown)
        XCTAssertEqual(controller.state.entries.count, 1, "folded, not dismissed")
        XCTAssertGreaterThan(controller.state.wingWidth, 0, "the wings carry the count even with no daily summary")
        model.mergePeriodic(try rule("p_a", occurrence: "po_2", revision: 2))
        try await settle()
        XCTAssertTrue(controller.state.stackShown)
        XCTAssertEqual(controller.state.entries.first?.repeats, 2)
    }

    func testARowLeavesOnlyAfterTheRuntimeAnswers() async throws {
        try requireNotch()
        let model = model()
        model.periodicReminders = [try rule("p_a")]; model.periodicLoaded = true
        let controller = started(model); defer { controller.stop() }
        var pending: StackAPIProtocol?
        let listed = try JSONSerialization.jsonObject(with: JSONEncoder().encode(try rule("p_a", revision: 4)))
        StackAPIProtocol.respond = { request in
            // A refused answer reloads the list; only the answer itself is held back.
            if request.request.url?.path.hasSuffix("/action") == true { pending = request }
            else { request.reply(["reminders": [listed]]) }
        }
        defer { StackAPIProtocol.respond = nil }
        controller.state.onCueComplete?("periodic:p_a")
        try await settle()
        XCTAssertTrue(controller.state.busyKeys.contains("periodic:p_a"))
        XCTAssertEqual(controller.state.entries.count, 1, "still there while the answer is in flight")
        // The runtime refuses: the row stays and says so.
        pending?.reply(["error": ["code": "INVALID_STATE", "message": "这条提醒已经失效"]], status: 409)
        try await settle()
        XCTAssertFalse(controller.state.busyKeys.contains("periodic:p_a"))
        XCTAssertEqual(controller.state.entries.count, 1)
        XCTAssertNotNil(controller.state.errors["periodic:p_a"])
        // Then it accepts.
        var completed = try JSONSerialization.jsonObject(with: JSONEncoder().encode(try rule("p_a", revision: 5, result: "completed"))) as! [String: Any]
        completed["state"] = "scheduled"
        StackAPIProtocol.respond = { request in request.reply(["reminder": completed]) }
        try await settle(0.2)
        controller.state.onCueComplete?("periodic:p_a")
        try await settle(0.8)
        XCTAssertTrue(controller.state.entries.isEmpty)
    }

    func testClicksElsewhereAndSpaceChangesDoNotDismissTheStack() async throws {
        try requireNotch()
        let model = model()
        model.periodicReminders = [try rule("p_a")]; model.periodicLoaded = true
        let controller = started(model); defer { controller.stop() }
        controller.collapse(immediately: true)          // what a space change or opening the panel does
        model.onCollapseNotch?()
        try await settle()
        XCTAssertTrue(controller.state.stackShown)
        XCTAssertEqual(controller.state.entries.count, 1)
    }

    /// Opt-in: `TODOCUE_STACK_SHOTS=/dir` writes the stack in each state, for the QA record.
    func testRenderStackStates() async throws {
        guard let output = ProcessInfo.processInfo.environment["TODOCUE_STACK_SHOTS"] else { throw XCTSkip("Opt-in screenshots") }
        _ = NSApplication.shared
        Dial.registerFonts()
        try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
        let original = LanguagePreferences.shared.language
        defer { LanguagePreferences.shared.language = original }
        let now = Date()
        func ago(_ minutes: Double) -> String { TCDate.iso(now.addingTimeInterval(-minutes * 60)) }
        let task = TodoTask(id: "t_review", title: "14:00 产品评审会", scheduledAt: TCDate.iso(now.addingTimeInterval(300)),
                            reminderAt: TCDate.iso(now), timezone: "Asia/Shanghai", status: .todo,
                            createdAt: TCDate.iso(now), updatedAt: TCDate.iso(now))
        let rules = [try CueStackTests.rule("p_move", occurrence: "po_move", at: ago(12)),
                     try CueStackTests.rule("p_water", occurrence: "po_water", at: ago(0)),
                     try CueStackTests.rule("p_eyes", occurrence: "po_eyes", at: ago(4)),
                     try CueStackTests.rule("p_stretch", occurrence: "po_stretch", at: ago(25))]
        func cues(_ count: Int) -> [CueEntry] {
            var stack = CueStack()
            stack.receive(ReminderCue(id: "r_review", task: task, count: 1, late: false, receivedAt: now), now: now)
            for rule in rules.prefix(max(0, count - 1)) { stack.receive(ReminderCue(periodic: rule, now: now), now: now) }
            return stack.shown
        }
        func render(_ name: String, entries: [CueEntry], featured: String?, shown: Bool, hovered: Bool = false, height: CGFloat, width: CGFloat = 460) throws {
            let model = self.model()
            model.periodicReminders = rules
            let state = NotchState()
            state.notchWidth = 185; state.notchHeight = 32
            state.wingWidth = entries.isEmpty ? 0 : Theme.notchWingWidth
            state.entries = entries; state.featuredKey = featured; state.stackShown = shown; state.cueHovered = hovered
            state.reduceMotion = true
            let view = NotchHostingView(rootView: NotchRootView(state: state, model: model))
            view.frame = NSRect(x: 0, y: 0, width: width, height: height)
            let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            window.backgroundColor = .clear; window.contentView = view
            window.orderFrontRegardless()
            view.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.4))
            view.layoutSubtreeIfNeeded()
            let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: rep)
            try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                .write(to: URL(fileURLWithPath: output).appendingPathComponent("\(name).png"))
            window.orderOut(nil)
        }
        for language in AppLanguage.allCases {
            LanguagePreferences.shared.language = language
            let tag = language.rawValue
            let one = Array(cues(2).suffix(1))
            try render("\(tag)-1-featured", entries: one, featured: one[0].key, shown: true, height: 190)
            try render("\(tag)-1-rest", entries: one, featured: nil, shown: true, height: 100)
            let three = cues(3)
            try render("\(tag)-3-arrival", entries: three, featured: three[2].key, shown: true, height: 330)
            try render("\(tag)-3-rest", entries: three, featured: nil, shown: true, height: 250)
            var repeated = cues(3); repeated[1].repeats = 3
            try render("\(tag)-3-repeat", entries: repeated, featured: nil, shown: true, height: 250)
            let five = cues(5)
            try render("\(tag)-5-fold", entries: five, featured: nil, shown: true, height: 300)
            try render("\(tag)-wings", entries: three, featured: nil, shown: false, height: 40, width: 293)
        }
    }
}
