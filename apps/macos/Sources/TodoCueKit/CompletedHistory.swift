import Foundation

/// Grouping and paging for the completed-work history.
///
/// The axis is the *completion* time, not the plan date. `listTasks`' `from`/`to` filter on
/// `planDate`, so a task scheduled in 2020 and finished today is excluded by any range covering
/// today — which makes range queries unusable here. The runtime already returns non-todo tasks
/// newest-completed first (`compareTasks`, and `orderTasks` leaves them alone), so asking for a
/// plain `status=done` with a limit yields exactly "the most recent N", not an arbitrary slice.
public enum CompletedHistory {
    /// One screenful and then some; "load earlier" grows the window from here.
    public static let pageSize = 60
    /// `ListTasksQuery.limit` is capped at 1000 by the schema, so this is as far back as the
    /// history can reach without a new query parameter.
    public static let maxWindow = 1000

    /// How many rows to ask for to fill `window` *and* learn whether more exist. One past the
    /// window, except at the ceiling: `ListTasksQuery.limit` is `max(1000)` and the server parses
    /// rather than clamps, so asking for 1001 is a validation error, not a capped response.
    public static func probe(window: Int) -> Int {
        min(max(window, 1) + 1, maxWindow)
    }

    /// Whether the response proves more history exists. At the ceiling the probe cannot see past
    /// it, so this is knowingly false and the view says it reached the limit instead.
    public static func hasMore(window: Int, received: Int) -> Bool {
        window < maxWindow && received > window
    }

    /// Applies one locally-changed task to a loaded page.
    ///
    /// `list` is newest-completed first. A task that is no longer done leaves; a known task is
    /// updated in place; a newly finished one is inserted in order. A task older than everything
    /// loaded is refused while more pages exist — adopting it would graft on a day group older
    /// than anything actually fetched, making the history look like it reaches further than it does.
    public static func merging(_ list: [TodoTask], with task: TodoTask, hasMore: Bool) -> [TodoTask] {
        var list = list
        guard task.status == .done else {
            list.removeAll { $0.id == task.id }
            return list
        }
        if let index = list.firstIndex(where: { $0.id == task.id }) {
            list[index] = task
            return list
        }
        func stamp(_ t: TodoTask) -> String { t.completedAt ?? t.updatedAt }
        guard let oldest = list.last.map(stamp) else { return [task] }
        guard stamp(task) >= oldest || !hasMore else { return list }
        let index = list.firstIndex { stamp($0) < stamp(task) } ?? list.count
        list.insert(task, at: index)
        return list
    }

    public struct Day: Identifiable, Equatable {
        public let date: String
        public let tasks: [TodoTask]
        public var id: String { date }
    }

    /// The local date a task was finished on, in the runtime's zone — the same rule the runtime
    /// uses to decide what belongs to "completed today".
    public static func completionDate(_ task: TodoTask, timezone: String) -> String? {
        guard let instant = TCDate.parse(task.completedAt ?? task.updatedAt) else { return nil }
        return TCDate.dateString(instant, timezone: timezone)
    }

    /// Days newest first, preserving the runtime's ordering within each day.
    public static func days(_ tasks: [TodoTask], timezone: String) -> [Day] {
        var order: [String] = []
        var byDate: [String: [TodoTask]] = [:]
        for task in tasks {
            guard let date = completionDate(task, timezone: timezone) else { continue }
            if byDate[date] == nil { order.append(date) }
            byDate[date, default: []].append(task)
        }
        return order.sorted(by: >).map { Day(date: $0, tasks: byDate[$0] ?? []) }
    }

    /// Case- and width-insensitive match over the fields a person would search by.
    public static func matching(_ tasks: [TodoTask], query: String) -> [TodoTask] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { return tasks }
        return tasks.filter { task in
            [task.title, task.project ?? "", task.notes ?? ""].contains { $0.localizedStandardContains(term) }
        }
    }
}
