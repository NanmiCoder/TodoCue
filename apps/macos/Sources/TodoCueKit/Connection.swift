import Foundation

public struct ConnectionInfo: Codable, Equatable, Sendable {
    public var baseUrl: String
    public var token: String
    public var pid: Int
    public var startedAt: String
    public var runtimeVersion: String

    public init(baseUrl: String, token: String, pid: Int, startedAt: String, runtimeVersion: String) {
        self.baseUrl = baseUrl; self.token = token; self.pid = pid; self.startedAt = startedAt; self.runtimeVersion = runtimeVersion
    }
}

public enum TodoCueHome {
    /// `$TODOCUE_HOME` or `~/.todocue`.
    public static var directory: URL {
        if let env = ProcessInfo.processInfo.environment["TODOCUE_HOME"], !env.isEmpty {
            return URL(fileURLWithPath: (env as NSString).expandingTildeInPath, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".todocue", isDirectory: true)
    }

    public static var connectionFile: URL { directory.appendingPathComponent("connection.json") }

    /// Resolves an explicit data directory (e.g. the notifier's `--home`, remembered in a
    /// notification's userInfo) and falls back to `directory` when none is given.
    public static func directory(explicit home: String?) -> URL {
        guard let home, !home.isEmpty else { return directory }
        return URL(fileURLWithPath: (home as NSString).expandingTildeInPath, isDirectory: true)
    }

    public static func loadConnection(home: String? = nil) -> ConnectionInfo? {
        let file = directory(explicit: home).appendingPathComponent("connection.json")
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(ConnectionInfo.self, from: data)
    }
}
