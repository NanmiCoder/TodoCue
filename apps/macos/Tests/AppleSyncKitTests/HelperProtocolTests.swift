import XCTest
import TodoCueKit
@testable import AppleSyncKit
@testable import TodoCueAppleSync

@MainActor
final class HelperProtocolTests: XCTestCase {
    func testCommandsDecode() throws {
        XCTAssertEqual(try HelperCommand.parse(#"{"id":4,"command":"setEnabled","kind":"reminder","enabled":true}"#),
                       HelperCommand(id: 4, command: .setEnabled, kind: .reminder, enabled: true))
        XCTAssertEqual(try HelperCommand.parse(#"{"command":"setLanguage","language":"en"}"#).language, "en")
        XCTAssertEqual(try HelperCommand.parse(#"{"id":5,"command":"setImportEnabled","enabled":true}"#),
                       HelperCommand(id: 5, command: .setImportEnabled, enabled: true))
        XCTAssertEqual(try HelperCommand.parse(#"{"id":6,"command":"setImportCalendar","calendar":"ABC-1","enabled":false}"#),
                       HelperCommand(id: 6, command: .setImportCalendar, enabled: false, calendar: "ABC-1"))
        XCTAssertThrowsError(try HelperCommand.parse(#"{"id":1,"command":"format"}"#))
        XCTAssertThrowsError(try HelperCommand.parse(#"{"id":1,"command":"removeData","kind":"todo"}"#))
    }

    func testResultLineKeepsNullFields() {
        XCTAssertEqual(HelperOutput.result(id: 3, message: nil, error: nil).line,
                       #"{"error":null,"id":3,"message":null,"type":"result"}"#)
        XCTAssertEqual(HelperOutput.result(id: 3, message: "未获得权限", error: nil).line,
                       #"{"error":null,"id":3,"message":"未获得权限","type":"result"}"#)
    }

    func testStatusReflectsTheController() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("todocue-helper-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let suite = "todocue-helper-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = FakeItemStore()
        store.source = "icloud"
        let backend = FakeBackend([AppleSyncControllerTests.task("a", dueDate: "2026-10-09")])
        let sync = AppleSyncController(store: store, stateURL: dir.appendingPathComponent("apple-sync.json"), defaults: defaults,
                                       client: "desktop", backend: { backend }, todoTasks: { backend.todo })

        var status = HelperStatus(sync, connected: false)
        XCTAssertFalse(status.reminder.enabled)
        XCTAssertEqual(status.reminder.access, "granted")
        XCTAssertNil(status.reminder.container)
        XCTAssertNil(status.lastSyncAt)

        let message = await sync.setEnabled(.reminder, true)
        XCTAssertNil(message)
        status = HelperStatus(sync, connected: true)
        XCTAssertTrue(status.reminder.enabled)
        XCTAssertFalse(status.event.enabled)
        XCTAssertEqual(status.reminder.container?.isICloud, true)
        XCTAssertNil(status.event.container)
        XCTAssertNotNil(status.lastSyncAt)
        XCTAssertEqual(store.items[.reminder]?.count, 1)

        store.granted = false
        sync.refreshAccess()
        XCTAssertEqual(HelperStatus(sync, connected: true).reminder.access, "denied")
    }

    func testStatusReportsImportCalendars() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("todocue-helper-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let suite = "todocue-helper-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = FakeItemStore()
        store.calendars = [AppleCalendarInfo(identifier: "boss", title: "BOSS直聘日历", sourceTitle: "iCloud", color: "#FF9500"),
                           AppleCalendarInfo(identifier: "work", title: "工作", sourceTitle: "iCloud")]
        let backend = FakeBackend([])
        let sync = AppleSyncController(store: store, stateURL: dir.appendingPathComponent("apple-sync.json"), defaults: defaults,
                                       client: "desktop", backend: { backend }, todoTasks: { backend.todo })
        sync.supportsImport = true

        XCTAssertEqual(HelperStatus(sync, connected: true).importing,
                       HelperStatus.Import(enabled: false, changing: false, calendars: []))
        _ = await sync.setImportEnabled(true)
        sync.setCalendarIncluded("work", false)
        let importing = HelperStatus(sync, connected: true).importing
        XCTAssertTrue(importing.enabled)
        XCTAssertEqual(importing.calendars.map(\.identifier), ["boss", "work"])
        XCTAssertEqual(importing.calendars.map(\.included), [true, false])
        XCTAssertEqual(importing.calendars.first?.color, "#FF9500")
        let line = HelperOutput.status(HelperStatus(sync, connected: true)).line
        XCTAssertTrue(line.contains(##""importing":{"calendars":[{"color":"#FF9500","identifier":"boss","included":true"##), line)
    }

    func testDesktopLanguageSetting() {
        XCTAssertEqual(AppLanguage(desktopSetting: "en"), .english)
        XCTAssertEqual(AppLanguage(desktopSetting: "zh-CN"), .chinese)
    }
}
