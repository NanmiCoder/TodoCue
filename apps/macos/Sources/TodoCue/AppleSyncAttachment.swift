import AppKit
import Combine
import AppleSyncKit
import TodoCueKit

extension AppleSyncController {
    /// Wire to the app model: board changes, reconnects and a slow heartbeat all trigger a round.
    func attach(to model: AppModel) {
        backend = { [weak model] in model?.canWrite == true ? model?.client : nil }
        todoTasks = { [weak model] in
            guard let model, model.connectionState.isOnline, model.context != nil else { return nil }
            return model.allTasks
        }
        retain(model.$allTasks.dropFirst().sink { [weak self] _ in self?.scheduleSync() })
        retain(model.$connectionState.removeDuplicates().filter(\.isOnline).sink { [weak self] _ in self?.scheduleSync() })
        startHeartbeat()
        scheduleSync()
    }
}
