import XCTest
@testable import TodoCueKit

final class NotificationPolicyTests: XCTestCase {
    private func snap(_ auth: String, style: String = "banner", alert: String = "enabled",
                      center: String = "enabled", sound: String = "enabled") -> NotificationSnapshot {
        NotificationSnapshot(authorization: auth, alertStyle: style, alertSetting: alert,
                             notificationCenterSetting: center, soundSetting: sound)
    }

    func testAuthorizedBannerIsVisibleAndDeliverable() {
        let s = snap("authorized")
        XCTAssertTrue(s.visible)
        XCTAssertNil(s.deliveryError)
    }

    func testProvisionalWithNotificationCenterOnlyIsVisible() {
        let s = snap("provisional", style: "none", alert: "disabled", center: "enabled")
        XCTAssertTrue(s.visible)
        XCTAssertNil(s.deliveryError)
    }

    func testNotDeterminedIsNotDeliverable() throws {
        let s = snap("notDetermined")
        XCTAssertFalse(s.visible)
        let error = try XCTUnwrap(s.deliveryError)
        XCTAssertTrue(error.contains("notDetermined"))
        XCTAssertTrue(error.contains("allow notifications"))
    }

    func testDeniedIsNotDeliverable() throws {
        let s = snap("denied")
        XCTAssertFalse(s.visible)
        XCTAssertTrue(try XCTUnwrap(s.deliveryError).hasPrefix("notifications denied"))
    }

    func testStyleNoneWithCenterOffIsInvisible() throws {
        let s = snap("authorized", style: "none", alert: "disabled", center: "disabled")
        XCTAssertFalse(s.visible)
        XCTAssertTrue(try XCTUnwrap(s.deliveryError).contains("None"))
    }

    func testAlertSwitchOffAndCenterOffIsInvisibleEvenIfStyleStale() {
        XCTAssertFalse(snap("authorized", style: "banner", alert: "disabled", center: "disabled").visible)
    }

    func testStyleNoneButCenterOnStillVisible() {
        XCTAssertTrue(snap("authorized", style: "none", alert: "enabled", center: "enabled").visible)
    }

    func testUnsupportedAlertSettingDefersToStyle() {
        XCTAssertTrue(snap("authorized", style: "alert", alert: "notSupported", center: "disabled").visible)
        XCTAssertFalse(snap("authorized", style: "none", alert: "notSupported", center: "disabled").visible)
    }

    func testUnknownAuthorizationDoesNotBlockButIsNotVisible() {
        let s = snap("unknown")
        XCTAssertFalse(s.visible)
        XCTAssertNil(s.deliveryError)
    }

    func testStatusFieldsCarryTheContractKeys() {
        let f = snap("authorized", style: "banner", sound: "disabled").statusFields
        XCTAssertEqual(Set(f.keys), ["authorization", "alertStyle", "alertSetting",
                                     "notificationCenterSetting", "soundSetting", "visible"])
        XCTAssertEqual(f["soundSetting"] as? String, "disabled")
        XCTAssertEqual(f["visible"] as? Bool, true)
    }

    func testFallbackURLs() {
        XCTAssertEqual(NotificationFallback.taskURL(taskId: "t1")?.absoluteString, "todocue://task/t1")
        XCTAssertEqual(NotificationFallback.taskURL(taskId: nil)?.absoluteString, "todocue://open")
    }

    func testExplicitHomeOverridesEnvironment() throws {
        XCTAssertEqual(TodoCueHome.directory(explicit: "/tmp/todocue-x").path, "/tmp/todocue-x")
        XCTAssertEqual(TodoCueHome.directory(explicit: nil), TodoCueHome.directory)
        XCTAssertEqual(TodoCueHome.directory(explicit: ""), TodoCueHome.directory)
    }

    func testLoadConnectionFromExplicitHome() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tc-home-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let json = #"{"baseUrl":"http://127.0.0.1:47999","token":"tok","pid":1,"startedAt":"x","runtimeVersion":"0"}"#
        try json.write(to: dir.appendingPathComponent("connection.json"), atomically: true, encoding: .utf8)
        XCTAssertEqual(TodoCueHome.loadConnection(home: dir.path)?.token, "tok")
        XCTAssertEqual(APIClient.fromHome(dir.path)?.baseURL.absoluteString, "http://127.0.0.1:47999")
        XCTAssertNil(TodoCueHome.loadConnection(home: dir.appendingPathComponent("missing").path))
    }
}
