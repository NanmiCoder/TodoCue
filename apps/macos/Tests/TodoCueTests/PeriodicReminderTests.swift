import XCTest
import AppKit
import SwiftUI
import TodoCueKit
@testable import TodoCue

private final class PeriodicAPIProtocol: URLProtocol {
    static var respond: ((PeriodicAPIProtocol) -> Void)?
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
    var body: [String: Any] {
        if let data = request.httpBody { return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
        guard let stream = request.httpBodyStream else { return [:] }
        stream.open(); defer { stream.close() }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }; data.append(contentsOf: buffer.prefix(count))
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
}

final class PeriodicReminderTests: XCTestCase {
    private func ruleObject() -> [String: Any] {
        ["id": "p_fixture", "title": "起来活动一下", "intervalMinutes": 30, "weekdays": Array(1...7),
         "windows": [["start": "09:00", "end": "18:00"]], "mode": "fixed", "timezone": "Asia/Shanghai", "enabled": true,
         "version": 1, "revision": 1, "pausedOn": NSNull(), "stateDate": "2026-10-11", "nextFireAt": "2026-10-11T02:30:00Z",
         "currentOccurrenceId": NSNull(), "currentOccurrence": NSNull(), "createdAt": "2026-10-11T01:00:00Z",
         "updatedAt": "2026-10-11T01:00:00Z", "summary": "每天 · 09:00–18:00 · 每 30 分钟", "state": "scheduled"]
    }
    @MainActor private func model() -> AppModel {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [PeriodicAPIProtocol.self]
        return AppModel(client: APIClient(baseURL: URL(string: "http://fixture.invalid")!, token: "test", session: URLSession(configuration: config)))
    }
    @MainActor private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
    @MainActor private func panel(_ model: AppModel, width: Double = 340) -> SidePanelController {
        _ = NSApplication.shared
        Dial.registerFonts()
        let name = "todocue-periodic-test-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.set(width, forKey: "panelWidth"); defaults.set(680.0, forKey: "panelHeight")
        let panel = SidePanelController(model: model, defaults: defaults)
        defaults.removePersistentDomain(forName: name)
        panel.show(focusInput: false)
        panel.resize(to: width, persist: false)
        return panel
    }
    @MainActor private func settle(_ panel: SidePanelController) async throws {
        try await Task.sleep(nanoseconds: 300_000_000); panel.window.contentView?.layoutSubtreeIfNeeded()
    }
    @MainActor func testDefaultsTemplatesValidationAndDraftPreservation() {
        let model = model()
        model.newPeriodic()
        guard case .periodicForm(var draft) = model.routes.last else { return XCTFail("missing form") }
        XCTAssertEqual(draft.configuration.intervalMinutes, 30)
        XCTAssertEqual(draft.configuration.weekdays, Array(1...7))
        XCTAssertEqual(draft.configuration.windows, [.init(start: "09:00", end: "18:00")])
        XCTAssertEqual(draft.mode, .fixed)
        XCTAssertNil(draft.createFields["timezone"], "new forms use the runtime default even before context loads")
        var explicit = draft; explicit.timezone = "America/New_York"; explicit.usesRuntimeTimezone = false
        XCTAssertEqual(explicit.createFields["timezone"], .string("America/New_York"))
        draft.weekdays = [6, 7]; draft.interval = "60"; draft.chooseTemplate("喝点水")
        XCTAssertEqual(draft.weekdays, [6, 7]); XCTAssertEqual(draft.interval, "60", "templates only change title")
        draft.windows = [.init(start: "09:00", end: "12:00"), .init(start: "13:00", end: "18:00")]
        XCTAssertTrue(draft.errors.isEmpty)
        model.updatePeriodicDraft(draft); model.pop(); model.newPeriodic()
        guard case .periodicForm(let resumed) = model.routes.last else { return XCTFail("missing form") }
        XCTAssertEqual(resumed, draft)
        draft.interval = "bad"; XCTAssertNotNil(draft.errors["interval"]); XCTAssertEqual(draft.title, "喝点水")
        draft.interval = "30"; draft.weekdays = []; XCTAssertNotNil(draft.errors["weekdays"])
        draft.weekdays = [7]; draft.windows = [.init(start: "23:00", end: "24:00")]; XCTAssertTrue(draft.errors.isEmpty)
        draft.windows = [.init(start: "24:00", end: "24:00")]; XCTAssertNotNil(draft.errors["windows"])
    }
    @MainActor func testSaveCreatesOnceWithStableKeyAndReturnsToManagementWithUndo() async throws {
        let model = model(), object = ruleObject()
        var requests: [URLRequest] = [], bodies: [[String: Any]] = []
        PeriodicAPIProtocol.respond = { request in requests.append(request.request); bodies.append(request.body); request.reply(["reminder": object]) }
        defer { PeriodicAPIProtocol.respond = nil }
        let draft = PeriodicDraft(timezone: "Asia/Shanghai")
        model.routes = [.periodicForm(draft)]
        let rule = try await model.savePeriodic(draft)
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].url?.path, "/v1/periodic-reminders")
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Idempotency-Key"), draft.operationKey)
        XCTAssertEqual(bodies[0]["intervalMinutes"] as? Int, 30)
        XCTAssertNil(bodies[0]["timezone"], "the server owns the default timezone")
        XCTAssertEqual(bodies[0]["weekdays"] as? [Int], Array(1...7))
        XCTAssertEqual(rule.id, "p_fixture"); XCTAssertEqual(model.routes, [.periodic])
        XCTAssertEqual(model.toast?.undoPeriodicId, rule.id)
        XCTAssertEqual(model.periodicReminders.count, 1)
        XCTAssertTrue(model.allTasks.isEmpty)
    }
    @MainActor func testLateSavePreservesReopenedModifiedDraft() async throws {
        let model = model(), object = ruleObject()
        let started = expectation(description: "save started")
        var pending: PeriodicAPIProtocol?
        PeriodicAPIProtocol.respond = { request in pending = request; started.fulfill() }
        defer { PeriodicAPIProtocol.respond = nil }
        model.newPeriodic()
        guard case .periodicForm(let submitted) = model.routes.last else { return XCTFail("missing form") }
        model.updatePeriodicDraft(submitted)
        let save = Task { try await model.savePeriodic(submitted) }
        await fulfillment(of: [started], timeout: 2)
        model.pop(); model.newPeriodic()
        guard case .periodicForm(var newer) = model.routes.last else { return XCTFail("missing reopened form") }
        newer.title = "new unsaved text"; model.updatePeriodicDraft(newer)
        pending?.reply(["reminder": object])
        _ = try await save.value
        XCTAssertEqual(model.savedPeriodicDraft?.title, newer.title)
        guard case .periodicForm(let preserved) = model.routes.last else { return XCTFail("must keep newer form") }
        XCTAssertEqual(preserved.title, newer.title)
        XCTAssertNotEqual(preserved.operationKey, submitted.operationKey)
        let nextObject = object.merging(["id": "p_second", "title": newer.title]) { _, new in new }
        var nextKey: String?
        PeriodicAPIProtocol.respond = { request in
            nextKey = request.request.value(forHTTPHeaderField: "Idempotency-Key")
            request.reply(["reminder": nextObject])
        }
        _ = try await model.savePeriodic(preserved)
        XCTAssertEqual(nextKey, preserved.operationKey)
        XCTAssertEqual(model.routes, [.periodic])
        XCTAssertEqual(model.periodicReminders.count, 2)
    }
    @MainActor func testStaleListAndClaimCannotOverwriteNewerStateOrResurrectDeletion() async throws {
        let model = model(), object = ruleObject()
        func decode(_ object: [String: Any]) throws -> PeriodicReminder {
            try JSONDecoder().decode(PeriodicReminder.self, from: JSONSerialization.data(withJSONObject: object))
        }
        let old = try decode(object)
        model.periodicReminders = [old]
        let started = expectation(description: "old list started")
        var pending: PeriodicAPIProtocol?
        PeriodicAPIProtocol.respond = { request in pending = request; started.fulfill() }
        defer { PeriodicAPIProtocol.respond = nil }
        let refresh = Task { await model.refreshPeriodic() }
        await fulfillment(of: [started], timeout: 2)
        var updated = object
        updated["revision"] = 3; updated["state"] = "waiting"; updated["nextFireAt"] = NSNull()
        let latest = try decode(updated)
        XCTAssertTrue(model.mergePeriodic(latest))
        pending?.reply(["reminders": [object]])
        await refresh.value
        XCTAssertEqual(model.periodicReminders.first?.revision, 3)
        XCTAssertFalse(model.mergePeriodic(old))
        var paused = updated
        paused["version"] = 2; paused["revision"] = 4; paused["enabled"] = false; paused["state"] = "paused"
        XCTAssertTrue(model.mergePeriodic(try decode(paused)))
        XCTAssertFalse(model.mergePeriodic(latest), "an older in-flight claim cannot replace pause")
        PeriodicAPIProtocol.respond = { request in request.reply(["deleted": true, "id": old.id]) }
        let didDelete = await model.actOnPeriodic(try decode(paused), action: "delete")
        XCTAssertTrue(didDelete)
        XCTAssertFalse(model.mergePeriodic(latest), "an older in-flight claim cannot recreate a deleted rule")
        XCTAssertTrue(model.periodicReminders.isEmpty)
    }
    @MainActor func testNativeLateSaveThenTypingUsesFreshOperationKeyAndEditVersion() async throws {
        let model = model()
        var originalObject = ruleObject()
        originalObject["version"] = 5
        let original = try JSONDecoder().decode(PeriodicReminder.self, from: JSONSerialization.data(withJSONObject: originalObject))
        let started = expectation(description: "edit save started")
        var pending: PeriodicAPIProtocol?
        PeriodicAPIProtocol.respond = { request in
            if request.request.url?.path.hasSuffix("/preview") == true {
                request.reply(["error": ["code": "UNAVAILABLE", "message": "fixture"]], status: 503)
            } else { pending = request; started.fulfill() }
        }
        defer { PeriodicAPIProtocol.respond = nil }
        model.editPeriodic(original)
        guard case .periodicForm(var submitted) = model.routes.last else { return XCTFail("missing edit") }
        submitted.title = "submitted text"; model.updatePeriodicDraft(submitted)
        let save = Task { try await model.savePeriodic(submitted) }
        await fulfillment(of: [started], timeout: 2)
        model.pop(); model.editPeriodic(original)
        guard case .periodicForm(var newer) = model.routes.last else { return XCTFail("missing reopened edit") }
        newer.title = "new unsaved text"; model.updatePeriodicDraft(newer)
        let panel = panel(model); defer { panel.window.orderOut(nil) }
        try await settle(panel)
        var savedObject = originalObject
        savedObject["version"] = 6; savedObject["revision"] = 6; savedObject["title"] = submitted.title
        pending?.reply(["reminder": savedObject])
        _ = try await save.value
        try await settle(panel)
        let root = try XCTUnwrap(panel.window.contentView)
        let title = try XCTUnwrap(descendants(root).compactMap { $0 as? NSTextField }.first { $0.stringValue == newer.title })
        title.selectText(nil)
        let editor = try XCTUnwrap(panel.window.firstResponder as? NSTextView)
        editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
        editor.insertText("!", replacementRange: editor.selectedRange())
        try await settle(panel)
        guard case .periodicForm(let typed) = model.routes.last else { return XCTFail("missing typed edit") }
        XCTAssertEqual(typed.title, newer.title + "!")
        XCTAssertNotEqual(typed.operationKey, submitted.operationKey)
        XCTAssertEqual(typed.version, 6)
        var nextBody: [String: Any] = [:], nextKey: String?
        let resaved = expectation(description: "native form resubmitted")
        PeriodicAPIProtocol.respond = { request in
            if request.request.url?.path.hasSuffix("/preview") == true {
                request.reply(["error": ["code": "UNAVAILABLE", "message": "fixture"]], status: 503)
            } else if request.request.httpMethod == "PATCH" {
                nextBody = request.body; nextKey = request.request.value(forHTTPHeaderField: "Idempotency-Key")
                request.reply(["reminder": savedObject]); resaved.fulfill()
            } else { request.reply(["reminders": [savedObject]]) }
        }
        let key = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command,
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.window.windowNumber, context: nil,
            characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        XCTAssertTrue(panel.window.performKeyEquivalent(with: key), "Command-Return invokes the actual form save")
        await fulfillment(of: [resaved], timeout: 2)
        try await settle(panel)
        XCTAssertEqual(nextKey, typed.operationKey)
        XCTAssertEqual(nextBody["expectedVersion"] as? Int, 6)
        XCTAssertEqual(nextBody["title"] as? String, newer.title + "!")
        XCTAssertEqual(model.routes, [.periodic])
    }
    @MainActor func testFailedSaveKeepsInputAndCreationCannotInheritAnEdit() async throws {
        let model = model()
        PeriodicAPIProtocol.respond = { request in request.reply(["error": ["code": "VERSION_CONFLICT", "message": "changed"]], status: 409) }
        defer { PeriodicAPIProtocol.respond = nil }
        let rule = try JSONDecoder().decode(PeriodicReminder.self, from: JSONSerialization.data(withJSONObject: ruleObject()))
        model.editPeriodic(rule)
        guard case .periodicForm(var edit) = model.routes.last else { return XCTFail("missing edit") }
        edit.title = "保留正在编辑的内容"; model.updatePeriodicDraft(edit)
        do { _ = try await model.savePeriodic(edit); XCTFail("must fail") } catch {}
        XCTAssertEqual(model.routes.last, .periodicForm(edit))
        model.pop(); model.newPeriodic()
        guard case .periodicForm(let fresh) = model.routes.last else { return XCTFail("missing create") }
        XCTAssertNil(fresh.editingId); XCTAssertNotEqual(fresh.title, edit.title)
        model.pop(); model.editPeriodic(rule)
        XCTAssertEqual(model.routes.last, .periodicForm(edit))
    }
    @MainActor func testRealNativeTitleTypingPreservesStateAndAdvancedControlsStartCollapsed() async throws {
        let model = model()
        PeriodicAPIProtocol.respond = { request in request.reply(["error": ["code": "UNAVAILABLE", "message": "fixture"]], status: 503) }
        defer { PeriodicAPIProtocol.respond = nil }
        model.newPeriodic()
        let panel = panel(model); defer { panel.window.orderOut(nil) }
        try await settle(panel)
        let root = try XCTUnwrap(panel.window.contentView)
        let fields = descendants(root).compactMap { $0 as? NSTextField }
        let title = try XCTUnwrap(fields.first { $0.stringValue == L10n.tr("起来活动一下") })
        XCTAssertFalse(fields.contains { $0.stringValue.contains("/") }, "timezone starts collapsed")
        title.selectText(nil)
        let editor = try XCTUnwrap(panel.window.firstResponder as? NSTextView)
        editor.selectAll(nil); editor.insertText("肩颈活动", replacementRange: editor.selectedRange())
        try await settle(panel)
        guard case .periodicForm(let edited) = model.routes.last else { return XCTFail("missing typed draft") }
        XCTAssertEqual(edited.title, "肩颈活动"); XCTAssertEqual(edited.interval, "30")
        model.pop(); model.newPeriodic(); try await settle(panel)
        XCTAssertTrue(descendants(root).compactMap { $0 as? NSTextField }.contains { $0.stringValue == "肩颈活动" })
    }
    @MainActor func testRealNotchClaimsDisplaysAndDoesNotTakeKeyboard() async throws {
        #if arch(x86_64)
        // GitHub's Intel VM exposes a screen but has no Metal target architecture.
        // SwiftUI's animated notch drawing aborts inside MTLLoader on that host.
        // Run this hardware rendering check on physical Intel Macs and ARM runners;
        // all model, transport, scheduling and form interaction tests still run here.
        if ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" {
            throw XCTSkip("Native animated notch requires a usable GPU; unavailable on GitHub's Intel VM")
        }
        #endif
        guard Prefs.isNotchEnabled, !NSScreen.screens.isEmpty else { throw XCTSkip("Notch display disabled or unavailable") }
        // A full-screen frontmost app makes the notch decline reminders; that is the machine's state, not the subject here.
        let savedFullscreenPreference = Prefs.disableNotchInFullscreen
        Prefs.disableNotchInFullscreen = false
        defer { Prefs.disableNotchInFullscreen = savedFullscreenPreference }
        let model = model()
        let now = TCDate.iso(Date())
        var object = ruleObject()
        var occurrence: [String: Any] = ["id": "po_native", "ruleId": "p_fixture", "ruleVersion": 1,
            "scheduledAt": now, "fireAt": now, "round": 1, "delivery": "offered", "result": "pending",
            "channel": NSNull(), "offeredAt": now, "claimToken": NSNull(), "claimedAt": NSNull(),
            "displayedAt": NSNull(), "handledAt": NSNull(), "lastError": NSNull(), "createdAt": now, "updatedAt": now]
        object["currentOccurrenceId"] = "po_native"; object["currentOccurrence"] = occurrence
        object["mode"] = "after_completion"; object["state"] = "waiting"; object["nextFireAt"] = NSNull()
        let rule = try JSONDecoder().decode(PeriodicReminder.self, from: JSONSerialization.data(withJSONObject: object))
        let previous = try JSONDecoder().decode(PeriodicReminder.self, from: JSONSerialization.data(withJSONObject: ruleObject()))
        model.periodicReminders = [previous]; model.periodicLoaded = true
        var didClaim = false, didReceipt = false
        PeriodicAPIProtocol.respond = { request in
            if request.request.url?.path.hasSuffix("/claim") == true {
                didClaim = true
                occurrence["delivery"] = "claimed"; occurrence["channel"] = "notch"
                occurrence["claimToken"] = request.body["token"]
                occurrence["claimedAt"] = TCDate.iso(Date())
                object["currentOccurrence"] = occurrence; object["revision"] = 3
            } else if request.request.url?.path.hasSuffix("/receipt") == true {
                didReceipt = request.body["displayed"] as? Bool == true
                occurrence["delivery"] = "displayed"; object["currentOccurrence"] = occurrence; object["revision"] = 4
            }
            request.reply(["reminder": object])
        }
        defer { PeriodicAPIProtocol.respond = nil }
        _ = NSApplication.shared
        let controller = NotchController(model: model)
        controller.start(); defer { controller.stop() }
        model.onPeriodicCue?(rule)
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertTrue(didClaim); XCTAssertTrue(didReceipt)
        XCTAssertEqual(controller.activeCue?.periodic?.id, rule.id)
        XCTAssertNil(controller.activeCue?.task)
        let window = try XCTUnwrap(NSApp.windows.compactMap { $0 as? NotchWindow }.first { $0.isVisible && $0.frame.width > 300 })
        XCTAssertFalse(window.canBecomeKey); XCTAssertFalse(window.isKeyWindow)
        XCTAssertEqual(window.frame.width, 460, accuracy: 1)
        if let output = ProcessInfo.processInfo.environment["TODOCUE_PERIODIC_SHOTS"], let view = window.contentView {
            view.layoutSubtreeIfNeeded()
            let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: rep)
            let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: output).appendingPathComponent("native-notch.png"))
        }
    }
    @MainActor func testRenderPeriodicScreens() async throws {
        guard let output = ProcessInfo.processInfo.environment["TODOCUE_PERIODIC_SHOTS"] else { throw XCTSkip("Opt-in screenshots") }
        let originalLanguage = LanguagePreferences.shared.language
        defer { LanguagePreferences.shared.language = originalLanguage }
        let object = ruleObject()
        PeriodicAPIProtocol.respond = { request in
            if request.request.url?.path == "/v1/periodic-reminders/preview" {
                var config = request.body
                if config["timezone"] == nil { config["timezone"] = "Asia/Shanghai" }
                request.reply(["config": config, "summary": "每天 · 09:00–18:00 · 每 30 分钟", "nextFireAt": "2026-10-11T02:30:00Z"])
            } else { request.reply(["reminders": [object]]) }
        }
        defer { PeriodicAPIProtocol.respond = nil }
        try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
        for language in AppLanguage.allCases {
            LanguagePreferences.shared.language = language
            for width in [300.0, 480.0] {
                let model = model(); model.newPeriodic()
                let panel = panel(model, width: width); defer { panel.window.orderOut(nil) }
                try await settle(panel)
                for name in ["create", "manage"] {
                    if name == "manage" { model.showPeriodic(); try await settle(panel) }
                    panel.window.makeFirstResponder(nil)
                    let view = try XCTUnwrap(panel.window.contentView)
                    let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
                    view.cacheDisplay(in: view.bounds, to: rep)
                    let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                    try png.write(to: URL(fileURLWithPath: output).appendingPathComponent("\(language.rawValue)-\(Int(width))-\(name).png"))
                }
            }
        }
    }
}
