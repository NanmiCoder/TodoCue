import XCTest
@testable import TodoCueKit

final class SSEParserTests: XCTestCase {
    func testParsesIdEventData() {
        var p = SSEParser()
        XCTAssertNil(p.feed(line: "id: 42"))
        XCTAssertNil(p.feed(line: "event: task.updated"))
        XCTAssertNil(p.feed(line: "data: {\"seq\":42}"))
        let msg = p.feed(line: "")
        XCTAssertEqual(msg, SSEMessage(id: "42", event: "task.updated", data: "{\"seq\":42}"))
    }

    func testIgnoresCommentsAndCRLF() {
        var p = SSEParser()
        XCTAssertNil(p.feed(line: ": ping"))
        XCTAssertNil(p.feed(line: ""))
        XCTAssertNil(p.feed(line: "data: a\r"))
        XCTAssertNil(p.feed(line: "data: b"))
        let msg = p.feed(line: "\r")
        XCTAssertEqual(msg?.data, "a\nb")
        XCTAssertNil(msg?.event)
    }

    func testIdPersistsAcrossMessages() {
        var p = SSEParser()
        _ = p.feed(line: "id: 1"); _ = p.feed(line: "data: x"); _ = p.feed(line: "")
        _ = p.feed(line: "data: y")
        let m2 = p.feed(line: "")
        XCTAssertEqual(m2?.id, "1")
    }

    func testEventDataDecodesToRuntimeEvent() throws {
        var p = SSEParser()
        _ = p.feed(line: "id: 7")
        _ = p.feed(line: "event: task.created")
        _ = p.feed(line: "data: {\"seq\":7,\"type\":\"task.created\",\"at\":\"2026-09-07T00:00:00.000Z\",\"id\":\"t_9\"}")
        let msg = p.feed(line: "")!
        let ev = try JSONDecoder().decode(RuntimeEvent.self, from: Data(msg.data.utf8))
        XCTAssertEqual(ev.type, .taskCreated)
        XCTAssertEqual(ev.id, "t_9")
    }
}
