import Foundation
import TodoCueKit

extension AppModel {
    func showPeriodic() {
        preserveDraft()
        if routes.last != .periodic { routes.append(.periodic) }
        onCollapseNotch?(); onOpenPanel?(false)
        Task { await refreshPeriodic() }
    }
    func newPeriodic() {
        preserveDraft()
        if case .periodicForm(let draft) = routes.last, draft.editingId == nil { onOpenPanel?(true); return }
        let draft = savedPeriodicDraft ?? PeriodicDraft(timezone: context?.timezone ?? TimeZone.current.identifier)
        routes.append(.periodicForm(draft)); onCollapseNotch?(); onOpenPanel?(true)
    }
    func editPeriodic(_ rule: PeriodicReminder) {
        preserveDraft()
        routes.append(.periodicForm(editingPeriodicDrafts[rule.id] ?? PeriodicDraft(editing: rule))); onOpenPanel?(true)
    }
    func updatePeriodicDraft(_ draft: PeriodicDraft) {
        if let index = routes.lastIndex(where: { if case .periodicForm(let current) = $0 { return current.saveKey == draft.saveKey }; return false }) {
            routes[index] = .periodicForm(draft)
        }
        if draft.editingId == nil { savedPeriodicDraft = draft }
        else if let id = draft.editingId { editingPeriodicDrafts[id] = draft }
    }
    func refreshPeriodic() async {
        guard let client else { return }
        let epoch = periodicCacheEpoch, request = UUID()
        periodicRefreshRequest = request
        do {
            let reminders = try await client.periodicReminders()
            guard periodicRefreshRequest == request, periodicCacheEpoch == epoch else { return }
            let cached = periodicReminders
            let returnedIds = Set(reminders.map(\.id))
            periodicDeletedIds.formUnion(cached.map(\.id).filter { !returnedIds.contains($0) })
            periodicReminders = reminders.filter { !periodicDeletedIds.contains($0.id) }.map { rule in
                guard let previous = cached.first(where: { $0.id == rule.id }), isOlderPeriodic(rule, than: previous) else { return rule }
                return previous
            }
            periodicLoadError = nil; periodicLoaded = true
        } catch {
            guard periodicRefreshRequest == request, periodicCacheEpoch == epoch else { return }
            periodicLoadError = error.localizedDescription
        }
    }
    private func isOlderPeriodic(_ rule: PeriodicReminder, than previous: PeriodicReminder) -> Bool {
        rule.version < previous.version || (rule.version == previous.version && (rule.revision ?? 0) < (previous.revision ?? 0))
    }
    @discardableResult
    func mergePeriodic(_ rule: PeriodicReminder) -> Bool {
        guard !periodicDeletedIds.contains(rule.id) else { return false }
        if let index = periodicReminders.firstIndex(where: { $0.id == rule.id }) {
            guard !isOlderPeriodic(rule, than: periodicReminders[index]) else { return false }
            periodicReminders[index] = rule
        } else { periodicReminders.append(rule) }
        periodicCacheEpoch += 1
        return true
    }
    private func removePeriodic(_ id: String) {
        periodicDeletedIds.insert(id)
        periodicCacheEpoch += 1
        periodicReminders.removeAll { $0.id == id }
    }
    private func finishPeriodicDraft(_ current: PeriodicDraft?, submitted: PeriodicDraft, saved: PeriodicReminder) -> PeriodicDraft? {
        guard var current else { return nil }
        if current.matchesSubmitted(submitted) { return nil }
        if current.saveKey == submitted.saveKey {
            // The original key belongs to the successful request, not to these newer edits.
            current.operationKey = UUID().uuidString
            if current.editingId != nil && current.version == submitted.version { current.version = saved.version }
        }
        return current
    }
    @discardableResult
    func savePeriodic(_ draft: PeriodicDraft) async throws -> PeriodicReminder {
        guard canWrite, let client else { throw APIError.transport(L10n.tr("离线状态下无法保存")) }
        let rule: PeriodicReminder
        if let id = draft.editingId, let version = draft.version {
            rule = try await client.updatePeriodic(id, config: draft.configuration, version: version, idempotencyKey: draft.operationKey)
        } else {
            rule = try await client.createPeriodic(draft.createFields, idempotencyKey: draft.operationKey)
        }
        mergePeriodic(rule)
        periodicSelectedId = rule.id
        if draft.editingId == nil {
            savedPeriodicDraft = finishPeriodicDraft(savedPeriodicDraft, submitted: draft, saved: rule)
        } else if let id = draft.editingId {
            editingPeriodicDrafts[id] = finishPeriodicDraft(editingPeriodicDrafts[id], submitted: draft, saved: rule)
        }
        let submittedRouteIsCurrent: Bool
        if case .periodicForm(let current) = routes.last { submittedRouteIsCurrent = current.matchesSubmitted(draft) }
        else { submittedRouteIsCurrent = false }
        if submittedRouteIsCurrent { routes = [.periodic] }
        else {
            routes = routes.compactMap { route in
                guard case .periodicForm(let current) = route, current.saveKey == draft.saveKey else { return route }
                guard let preserved = finishPeriodicDraft(current, submitted: draft, saved: rule) else { return nil }
                // Keep the route and draft cache on the same idempotency key.
                if preserved.editingId == nil { savedPeriodicDraft = preserved }
                else if let id = preserved.editingId { editingPeriodicDrafts[id] = preserved }
                return .periodicForm(preserved)
            }
        }
        showToast(Toast(message: L10n.tr("已保存「\(rule.title)」"), undoPeriodicId: draft.editingId == nil ? rule.id : nil,
                       undoPeriodicVersion: draft.editingId == nil ? rule.version : nil))
        return rule
    }
    @discardableResult
    func actOnPeriodic(_ rule: PeriodicReminder, action: String, occurrence: PeriodicOccurrence? = nil) async -> Bool {
        guard canWrite, let client else { return false }
        do {
            let current = occurrence ?? rule.currentOccurrence
            let result = try await client.periodicAction(rule.id, action: action, version: rule.version,
                occurrenceId: current?.id, round: current?.round)
            if let updated = result.reminder { mergePeriodic(updated) }
            if result.deleted == true { removePeriodic(rule.id) }
            return true
        } catch {
            showToast(Toast(message: error.localizedDescription, isError: true))
            await refreshPeriodic()
            return false
        }
    }
    func undoPeriodicCreate(_ id: String, version: Int?) {
        guard let client else { return }
        toast = nil
        Task {
            do {
                _ = try await client.periodicAction(id, action: "delete", version: version)
                removePeriodic(id)
            } catch { showToast(Toast(message: error.localizedDescription, isError: true)) }
        }
    }
    func revealPeriodic(_ id: String) {
        periodicSelectedId = id
        showPeriodic()
    }
}
