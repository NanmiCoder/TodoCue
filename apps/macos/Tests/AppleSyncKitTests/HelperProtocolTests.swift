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

    func testDesktopLanguageSetting() {
        XCTAssertEqual(AppLanguage(desktopSetting: "en"), .english)
        XCTAssertEqual(AppLanguage(desktopSetting: "zh-CN"), .chinese)
    }
}
