import Foundation

/// One parsed Server-Sent Event.
public struct SSEMessage: Equatable, Sendable {
    public var id: String?
    public var event: String?
    public var data: String
    public init(id: String? = nil, event: String? = nil, data: String) { self.id = id; self.event = event; self.data = data }
}

/// Incremental parser for the SSE wire format (text/event-stream).
public struct SSEParser: Sendable {
    private var id: String?
    private var event: String?
    private var dataLines: [String] = []

    public init() {}

    /// Feed a single line (without trailing newline). Returns a message when a blank line completes one.
    public mutating func feed(line rawLine: String) -> SSEMessage? {
        var line = rawLine
        if line.hasSuffix("\r") { line.removeLast() }
        if line.isEmpty {
            guard !dataLines.isEmpty || event != nil else { id = nil; return nil }
            let msg = SSEMessage(id: id, event: event, data: dataLines.joined(separator: "\n"))
            event = nil; dataLines = []
            return msg
        }
        if line.hasPrefix(":") { return nil } // comment / ping
        let field: String
        var value: String
        if let idx = line.firstIndex(of: ":") {
            field = String(line[..<idx])
            value = String(line[line.index(after: idx)...])
            if value.hasPrefix(" ") { value.removeFirst() }
        } else {
            field = line; value = ""
        }
        switch field {
        case "id": id = value
        case "event": event = value
        case "data": dataLines.append(value)
        default: break
        }
        return nil
    }
}

public enum SSEConnectionState: Equatable, Sendable {
    case connecting, connected, disconnected(String)
}

/// Streams `RuntimeEvent`s from `/v1/events`, reconnecting with backoff.
public final class SSEClient: @unchecked Sendable {
    public enum Item: Sendable {
        case state(SSEConnectionState)
        case event(RuntimeEvent)
    }

    private let makeRequest: @Sendable () -> URLRequest?
    private var task: Task<Void, Never>?
    private var lastEventId: String?
    private let session: URLSession

    public init(session: URLSession? = nil, makeRequest: @escaping @Sendable () -> URLRequest?) {
        self.makeRequest = makeRequest
        if let session { self.session = session } else {
            let cfg = URLSessionConfiguration.default
            cfg.timeoutIntervalForRequest = 60
            cfg.timeoutIntervalForResource = .infinity
            self.session = URLSession(configuration: cfg)
        }
    }

    public convenience init(client: APIClient) {
        self.init { client.makeRequest("GET", "/v1/events") }
    }

    /// Starts the stream. Cancel the returned task or call `stop()` to end it.
    public func start() -> AsyncStream<Item> {
        stop()
        let (stream, continuation) = AsyncStream<Item>.makeStream()
        let session = self.session
        task = Task { [weak self] in
            var backoff: Double = 1
            while !Task.isCancelled {
                guard let self, var req = self.makeRequest() else {
                    continuation.yield(.state(.disconnected("no connection info")))
                    try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
                    backoff = min(backoff * 2, 15)
                    continue
                }
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
                req.timeoutInterval = 60
                if let last = self.lastEventId { req.setValue(last, forHTTPHeaderField: "Last-Event-ID") }
                continuation.yield(.state(.connecting))
                do {
                    let (bytes, resp) = try await session.bytes(for: req)
                    guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
                        throw APIError.http(status: code, code: "HTTP_\(code)", message: "events stream refused")
                    }
                    continuation.yield(.state(.connected))
                    backoff = 1
                    var parser = SSEParser()
                    // NOTE: `bytes.lines` drops empty lines, but SSE uses a blank line to
                    // terminate each event, so split on raw newlines ourselves.
                    var lineBuffer: [UInt8] = []
                    lineBuffer.reserveCapacity(1024)
                    for try await byte in bytes {
                        if Task.isCancelled { break }
                        if byte == 0x0A {
                            let line = String(decoding: lineBuffer, as: UTF8.self)
                            lineBuffer.removeAll(keepingCapacity: true)
                            if let msg = parser.feed(line: line) {
                                if let id = msg.id { self.lastEventId = id }
                                if let data = msg.data.data(using: .utf8),
                                   let ev = try? JSONDecoder().decode(RuntimeEvent.self, from: data) {
                                    continuation.yield(.event(ev))
                                }
                            }
                        } else {
                            lineBuffer.append(byte)
                        }
                    }
                    if Task.isCancelled { break }
                    continuation.yield(.state(.disconnected("stream ended")))
                } catch {
                    if Task.isCancelled { break }
                    continuation.yield(.state(.disconnected(error.localizedDescription)))
                }
                try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
                backoff = min(backoff * 2, 15)
            }
            continuation.finish()
        }
        return stream
    }

    public func stop() {
        task?.cancel()
        task = nil
    }

    deinit { task?.cancel() }
}
