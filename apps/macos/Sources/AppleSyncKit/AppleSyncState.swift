import Foundation
import TodoCueKit

/// Links and containers, kept next to the runtime's data so `TODOCUE_HOME` isolates them too.
public struct AppleSyncState: Codable, Equatable {
    var calendarId: String?
    var reminderListId: String?
    /// The account each container lives in. Kept after the container is gone so sync never wanders
    /// into another account by itself.
    var calendarSourceId: String?
    var reminderSourceId: String?
    var links: [AppleSyncLink] = []
    /// The client that last completed a round over these links. Clients older than this field drop it
    /// when they save, which is what makes the next client treat the links as possibly stale.
    var client: String?
    /// Events imported from other calendars. Saved in a file of their own (`importsURL`): clients that
    /// predate import rewrite apple-sync.json without the fields they do not know, and losing these
    /// records would import every upcoming event again.
    var imports: [AppleCalendarImport]?

    private enum CodingKeys: String, CodingKey {
        case calendarId, reminderListId, calendarSourceId, reminderSourceId, links, client
    }

    private struct ImportFile: Codable { var imports: [AppleCalendarImport] }

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

    func importRecord(taskId: String) -> AppleCalendarImport? { imports?.first { $0.taskId == taskId } }

    mutating func upsertImport(_ record: AppleCalendarImport) {
        var all = imports ?? []
        if let i = all.firstIndex(where: { $0.taskId == record.taskId }) { all[i] = record } else { all.append(record) }
        imports = all
    }

    mutating func removeImport(taskId: String) {
        imports?.removeAll { $0.taskId == taskId }
        if imports?.isEmpty == true { imports = nil }
    }

    public static var defaultURL: URL { TodoCueHome.directory.appendingPathComponent("apple-sync.json") }

    /// The import records' file, beside apple-sync.json.
    static func importsURL(for url: URL) -> URL {
        url.deletingLastPathComponent().appendingPathComponent("apple-calendar-import.json")
    }

    static func load(from url: URL) -> AppleSyncState {
        var state = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(AppleSyncState.self, from: $0) }
            ?? AppleSyncState()
        if let data = try? Data(contentsOf: importsURL(for: url)),
           let file = try? JSONDecoder().decode(ImportFile.self, from: data), !file.imports.isEmpty {
            state.imports = file.imports
        }
        return state
    }

    func save(to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        func write(_ data: Data, to target: URL) throws {
            try data.write(to: target, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
        }
        try write(encoder.encode(self), to: url)
        let importsURL = Self.importsURL(for: url)
        if let imports, !imports.isEmpty {
            try write(encoder.encode(ImportFile(imports: imports)), to: importsURL)
        } else if FileManager.default.fileExists(atPath: importsURL.path) {
            try FileManager.default.removeItem(at: importsURL)
        }
    }
}
