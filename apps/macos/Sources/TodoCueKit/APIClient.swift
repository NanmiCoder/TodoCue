import Foundation

public enum APIError: Error, LocalizedError, Sendable {
    case notConnected
    case http(status: Int, code: String, message: String)
    case transport(String)
    case decoding(String)

    public var code: String? {
        if case .http(_, let code, _) = self { return code }
        return nil
    }

    public var errorDescription: String? {
        switch self {
        case .notConnected: return "未连接到 TodoCue 运行时"
        case .http(_, let code, let message): return "\(message) (\(code))"
        case .transport(let m): return m
        case .decoding(let m): return "解析响应失败：\(m)"
        }
    }

    public var isVersionConflict: Bool { code == "VERSION_CONFLICT" }
}

public struct APIClient: Sendable {
    public let baseURL: URL
    public let token: String
    private let session: URLSession

    public init(connection: ConnectionInfo, session: URLSession = .shared) {
        self.baseURL = URL(string: connection.baseUrl) ?? URL(string: "http://127.0.0.1:47831")!
        self.token = connection.token
        self.session = session
    }

    public init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL; self.token = token; self.session = session
    }

    public static func fromHome() -> APIClient? {
        guard let c = TodoCueHome.loadConnection() else { return nil }
        return APIClient(connection: c)
    }

    private static let decoder = JSONDecoder()
    private static let encoder: JSONEncoder = { let e = JSONEncoder(); e.outputFormatting = [.sortedKeys]; return e }()

    public func makeRequest(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil,
                            idempotencyKey: String? = nil) -> URLRequest {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let idempotencyKey { req.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        req.timeoutInterval = 10
        return req
    }

    public func send<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [],
                                   json: (any Encodable)? = nil, idempotencyKey: String? = nil) async throws -> T {
        let data = try await raw(method, path, query: query, json: json, idempotencyKey: idempotencyKey)
        do { return try Self.decoder.decode(T.self, from: data) }
        catch { throw APIError.decoding("\(error)") }
    }

    public func raw(_ method: String, _ path: String, query: [URLQueryItem] = [],
                    json: (any Encodable)? = nil, idempotencyKey: String? = nil) async throws -> Data {
        var body: Data? = nil
        if let json { body = try Self.encoder.encode(AnyEncodable(json)) }
        let req = makeRequest(method, path, query: query, body: body, idempotencyKey: idempotencyKey)
        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await session.data(for: req) }
        catch { throw APIError.transport(error.localizedDescription) }
        guard let http = resp as? HTTPURLResponse else { throw APIError.transport("no HTTP response") }
        if http.statusCode >= 400 {
            if let e = try? Self.decoder.decode(APIErrorBody.self, from: data) {
                throw APIError.http(status: http.statusCode, code: e.error.code, message: e.error.message)
            }
            throw APIError.http(status: http.statusCode, code: "HTTP_\(http.statusCode)", message: String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }

    // MARK: - Typed endpoints

    public struct TaskEnvelope: Codable, Sendable { public var task: TodoTask; public var series: Series?; public var reminder: Reminder? }
    public struct TasksEnvelope: Codable, Sendable { public var tasks: [TodoTask] }
    public struct SeriesEnvelope: Codable, Sendable { public var series: Series; public var tasks: [TodoTask]? }
    public struct SeriesListEnvelope: Codable, Sendable { public var series: [Series] }
    public struct StopSeriesEnvelope: Codable, Sendable { public var series: Series; public var cancelledTaskIds: [String] }
    public struct RemindersEnvelope: Codable, Sendable { public var reminders: [Reminder] }
    public struct AuthorizationEnvelope: Codable, Sendable { public var authorization: String }
    public struct TestNotificationEnvelope: Codable, Sendable { public var ok: Bool; public var channel: String? }
    public struct HealthEnvelope: Codable, Sendable { public var ok: Bool; public var runtimeVersion: String; public var pid: Int }

    public struct OrderedGroup: Codable, Sendable {
        public var view: String
        public var group: String
        public var taskIds: [String]
    }
    public struct OrderingState: Codable, Sendable {
        public var revision: Int
        public var groups: [OrderedGroup]
        public static let empty = OrderingState(revision: 0, groups: [])
    }
    public struct Board: Decodable, Sendable {
        public var context: ContextInfo
        public var today: TodayResult
        public var next: NextResult
        public var all: [TodoTask]
        public var upcoming: [TodoTask]
        public var ordering: OrderingState
    }
    public struct OrderResult: Decodable, Sendable {
        public var ordering: OrderingState
        public var undoToken: String?
    }
    public func board() async throws -> Board { try await send("GET", "/v1/board") }
    public func moveTask(_ id: String, payload: TaskPayload) async throws -> OrderResult {
        try await send("POST", "/v1/tasks/\(id)/move", json: payload.fields, idempotencyKey: UUID().uuidString)
    }
    public func resetOrder(view: String, group: String, revision: Int) async throws -> OrderResult {
        try await send("POST", "/v1/ordering/reset", json: ["view": JSONValue.string(view), "group": .string(group), "expectedRevision": .int(revision)], idempotencyKey: UUID().uuidString)
    }
    public func undoOrder(token: String, revision: Int) async throws -> OrderResult {
        try await send("POST", "/v1/ordering/undo", json: ["token": JSONValue.string(token), "expectedRevision": .int(revision)], idempotencyKey: UUID().uuidString)
    }

    public func health() async throws -> HealthEnvelope { try await send("GET", "/v1/health") }
    public func context() async throws -> ContextInfo { try await send("GET", "/v1/context") }
    public func today() async throws -> TodayResult { try await send("GET", "/v1/today") }
    public func next() async throws -> NextResult { try await send("GET", "/v1/next") }

    public func tasks(status: [TaskStatus] = [.todo], project: String? = nil, from: String? = nil, to: String? = nil,
                      includeUnscheduled: Bool? = nil, limit: Int? = nil) async throws -> [TodoTask] {
        var q = status.map { URLQueryItem(name: "status", value: $0.rawValue) }
        if let project { q.append(.init(name: "project", value: project)) }
        if let from { q.append(.init(name: "from", value: from)) }
        if let to { q.append(.init(name: "to", value: to)) }
        if let includeUnscheduled { q.append(.init(name: "includeUnscheduled", value: includeUnscheduled ? "true" : "false")) }
        if let limit { q.append(.init(name: "limit", value: String(limit))) }
        let env: TasksEnvelope = try await send("GET", "/v1/tasks", query: q)
        return env.tasks
    }

    public func task(_ id: String) async throws -> TaskEnvelope { try await send("GET", "/v1/tasks/\(id)") }

    public func createTask(_ payload: TaskPayload, idempotencyKey: String = UUID().uuidString) async throws -> TaskEnvelope {
        try await send("POST", "/v1/tasks", json: payload.fields, idempotencyKey: idempotencyKey)
    }

    public func updateTask(_ id: String, _ payload: TaskPayload, expectedVersion: Int?) async throws -> TodoTask {
        var p = payload
        if let v = expectedVersion { p.fields["expectedVersion"] = .int(v) }
        let env: TaskEnvelope = try await send("PATCH", "/v1/tasks/\(id)", json: p.fields)
        return env.task
    }

    private func action(_ id: String, _ name: String, expectedVersion: Int?, extra: [String: JSONValue] = [:]) async throws -> TodoTask {
        var body = extra
        if let v = expectedVersion { body["expectedVersion"] = .int(v) }
        let env: TaskEnvelope = try await send("POST", "/v1/tasks/\(id)/\(name)", json: body, idempotencyKey: UUID().uuidString)
        return env.task
    }

    public func complete(_ id: String, expectedVersion: Int? = nil) async throws -> TodoTask { try await action(id, "complete", expectedVersion: expectedVersion) }
    public func reopen(_ id: String, expectedVersion: Int? = nil) async throws -> TodoTask { try await action(id, "reopen", expectedVersion: expectedVersion) }
    public func cancel(_ id: String, expectedVersion: Int? = nil) async throws -> TodoTask { try await action(id, "cancel", expectedVersion: expectedVersion) }
    public func skip(_ id: String, expectedVersion: Int? = nil) async throws -> TodoTask { try await action(id, "skip", expectedVersion: expectedVersion) }
    public func snooze(_ id: String, minutes: Int = 10, expectedVersion: Int? = nil) async throws -> TodoTask {
        try await action(id, "snooze", expectedVersion: expectedVersion, extra: ["minutes": .int(minutes)])
    }
    public func snooze(_ id: String, until: Date, expectedVersion: Int? = nil) async throws -> TodoTask {
        try await action(id, "snooze", expectedVersion: expectedVersion, extra: ["until": .string(TCDate.iso(until))])
    }

    public func attachmentData(_ attachment: TaskAttachment) async throws -> Data {
        try await raw("GET", "/v1/tasks/\(attachment.taskId)/attachments/\(attachment.id)/content")
    }

    public func series(status: SeriesStatus? = nil) async throws -> [Series] {
        var q: [URLQueryItem] = []
        if let status { q.append(.init(name: "status", value: status.rawValue)) }
        let env: SeriesListEnvelope = try await send("GET", "/v1/series", query: q)
        return env.series
    }
    public func series(_ id: String) async throws -> SeriesEnvelope { try await send("GET", "/v1/series/\(id)") }
    public func stopSeries(_ id: String, expectedVersion: Int? = nil) async throws -> StopSeriesEnvelope {
        var body: [String: JSONValue] = [:]
        if let v = expectedVersion { body["expectedVersion"] = .int(v) }
        return try await send("POST", "/v1/series/\(id)/stop", json: body, idempotencyKey: UUID().uuidString)
    }

    public func reminders(status: [ReminderStatus] = [], taskId: String? = nil) async throws -> [Reminder] {
        var q = status.map { URLQueryItem(name: "status", value: $0.rawValue) }
        if let taskId { q.append(.init(name: "taskId", value: taskId)) }
        let env: RemindersEnvelope = try await send("GET", "/v1/reminders", query: q)
        return env.reminders
    }

    public func doctor() async throws -> DoctorReport { try await send("GET", "/v1/doctor") }
    public func exportJSON() async throws -> Data { try await raw("GET", "/v1/export") }
    public func requestNotificationAuthorization() async throws -> String {
        let env: AuthorizationEnvelope = try await send("POST", "/v1/notifications/request-authorization", json: [String: JSONValue]())
        return env.authorization
    }
    public func sendTestNotification() async throws -> TestNotificationEnvelope {
        try await send("POST", "/v1/notifications/test", json: ["title": JSONValue.string("TodoCue 测试通知"), "body": .string("通知链路正常")])
    }
}

/// Type-erasing wrapper so we can encode `any Encodable`.
struct AnyEncodable: Encodable {
    let value: any Encodable
    init(_ value: any Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}
