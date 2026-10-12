import XCTest
import TodoCueKit
@testable import TodoCue

/// Answers every request from `respond`, so the delete paths run against a scripted runtime.
private final class DeleteAPIProtocol: URLProtocol {
    struct Reply { var status: Int; var json: Any }
    static var respond: ((URLRequest) -> Reply)?
    static var requests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let reply = Self.respond?(request) ?? Reply(status: 500, json: [:])
        let data = try! JSONSerialization.data(withJSONObject: reply.json)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: reply.status,
            httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    static func body(of request: URLRequest) -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
}

final class DeleteTaskTests: XCTestCase {
    private func task(_ id: String = "a", version: Int = 3) -> TodoTask {
        TodoTask(id: id, title: "任务 \(id)", timezone: "Asia/Shanghai", version: version,
                 createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z")
    }
    private func json(_ task: TodoTask) -> Any { try! JSONSerialization.jsonObject(with: JSONEncoder().encode(task)) }
    private func notFound(_ message: String) -> DeleteAPIProtocol.Reply {
        .init(status: 404, json: ["error": ["code": "NOT_FOUND", "message": message]])
    }
    private func client() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DeleteAPIProtocol.self]
        return APIClient(baseURL: URL(string: "http://fixture.invalid")!, token: "fixture",
                         session: URLSession(configuration: config))
    }

    override func setUp() {
        DeleteAPIProtocol.requests = []
        DeleteAPIProtocol.respond = nil
    }

    // MARK: - APIClient

    func testDeleteReturnsTheRemovedTaskAndSendsTheVersion() async throws {
        let t = task()
        DeleteAPIProtocol.respond = { _ in .init(status: 200, json: ["deleted": true, "task": self.json(t)]) }
        let removed = try await client().deleteTask("a", expectedVersion: 3)
        XCTAssertEqual(removed?.id, "a")
        let request = try XCTUnwrap(DeleteAPIProtocol.requests.first)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path, "/v1/tasks/a")
        XCTAssertEqual(DeleteAPIProtocol.body(of: request)["expectedVersion"] as? Int, 3)
    }

    func testAnAlreadyDeletedTaskIsDoneNotAnError() async throws {
        DeleteAPIProtocol.respond = { _ in self.notFound("task a not found") }
        let removed = try await client().deleteTask("a")
        XCTAssertNil(removed)
        XCTAssertEqual(DeleteAPIProtocol.requests.map(\.httpMethod), ["DELETE", "GET"])
    }

    func testAMissingRouteIsNotMistakenForAnAlreadyDeletedTask() async throws {
        // A runtime older than the app has no DELETE route: it answers 404 NOT_FOUND although the
        // task is still there, which must surface as a failure, not as a successful delete.
        DeleteAPIProtocol.respond = { request in
            if request.httpMethod == "DELETE" { return self.notFound("route DELETE /v1/tasks/a not found") }
            return .init(status: 200, json: ["task": self.json(self.task())])
        }
        do {
            _ = try await client().deleteTask("a")
            XCTFail("the task still exists, so this must not read as deleted")
        } catch APIError.http(404, _, _) {
            // expected
        }
    }

    func testAVersionConflictIsNotSwallowed() async throws {
        DeleteAPIProtocol.respond = { _ in
            .init(status: 409, json: ["error": ["code": "VERSION_CONFLICT", "message": "stale"]])
        }
        do {
            _ = try await client().deleteTask("a", expectedVersion: 1)
            XCTFail("expected a conflict")
        } catch let error as APIError {
            XCTAssertTrue(error.isVersionConflict)
        }
        XCTAssertEqual(DeleteAPIProtocol.requests.count, 1, "a conflict needs no lookup")
    }

    // MARK: - AppModel

    @MainActor func testRequestingDeleteAsksFirstAndOpensThePanelWithoutTakingFocus() {
        let model = AppModel(client: client())
        var requestedFocus: [Bool] = []
        model.onOpenPanel = { requestedFocus.append($0) }
        model.requestDelete(task())
        XCTAssertEqual(model.pendingDelete?.id, "a")
        XCTAssertEqual(requestedFocus, [false])
        XCTAssertTrue(DeleteAPIProtocol.requests.isEmpty, "asking must not delete anything")
    }

    @MainActor func testRequestingDeleteOfflineSaysSoInsteadOfAsking() {
        let model = AppModel()
        model.requestDelete(task())
        XCTAssertNil(model.pendingDelete)
        XCTAssertEqual(model.toast?.isError, true)
    }

    @MainActor func testDeletingClosesTheTaskPagesAndItsDraft() async {
        DeleteAPIProtocol.respond = { _ in .init(status: 200, json: ["deleted": true, "task": self.json(self.task())]) }
        let model = AppModel(client: client())
        let t = task()
        model.edit(t)
        model.routes.insert(.detail("a"), at: 0)
        model.routes.append(.detail("other"))
        model.pendingDelete = t

        let done = await model.deleteTask(t)

        XCTAssertTrue(done)
        XCTAssertNil(model.pendingDelete)
        XCTAssertEqual(model.routes, [.detail("other")], "only the deleted task's pages go")
        XCTAssertTrue(model.toast?.message.contains("任务 a") == true, "the toast names the deleted task")
        XCTAssertEqual(model.toast?.isError, false)
    }

    @MainActor func testAFailedDeleteKeepsEverythingAndReportsTheError() async {
        DeleteAPIProtocol.respond = { _ in .init(status: 500, json: ["error": ["code": "INTERNAL", "message": "boom"]]) }
        let model = AppModel(client: client())
        let t = task()
        model.routes = [.detail("a")]

        let done = await model.deleteTask(t)

        XCTAssertFalse(done)
        XCTAssertEqual(model.routes, [.detail("a")])
        XCTAssertEqual(model.toast?.isError, true)
    }
}
