import Foundation
import TodoCueKit

/// Links and containers, kept next to the runtime's data so `TODOCUE_HOME` isolates them too.
struct AppleSyncState: Codable, Equatable {
    var calendarId: String?
    var reminderListId: String?
    /// The account each container lives in. Kept after the container is gone so sync never wanders
    /// into another account by itself.
    var calendarSourceId: String?
    var reminderSourceId: String?
    var links: [AppleSyncLink] = []

    func containerId(_ kind: AppleSyncKind) -> String? { kind == .event ? calendarId : reminderListId }
    func sourceId(_ kind: AppleSyncKind) -> String? { kind == .event ? calendarSourceId : reminderSourceId }

    mutating func setContainer(_ id: String?, source: String?, for kind: AppleSyncKind) {
        if kind == .event { calendarId = id; calendarSourceId = source }
        else { reminderListId = id; reminderSourceId = source }
    }

    func links(_ kind: AppleSyncKind) -> [AppleSyncLink] { links.filter { $0.kind == kind } }

    func link(_ kind: AppleSyncKind, taskId: String) -> AppleSyncLink? {
        links.first { $0.kind == kind && $0.taskId == taskId }
    }

    mutating func upsert(_ link: AppleSyncLink) {
        if let i = links.firstIndex(where: { $0.kind == link.kind && $0.taskId == link.taskId }) { links[i] = link }
        else { links.append(link) }
    }

    mutating func removeLink(_ kind: AppleSyncKind, taskId: String) {
        links.removeAll { $0.kind == kind && $0.taskId == taskId }
    }

    static var defaultURL: URL { TodoCueHome.directory.appendingPathComponent("apple-sync.json") }

    static func load(from url: URL) -> AppleSyncState {
        guard let data = try? Data(contentsOf: url),
              let state = try? JSONDecoder().decode(AppleSyncState.self, from: data) else { return AppleSyncState() }
        return state
    }

    func save(to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try encoder.encode(self).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
