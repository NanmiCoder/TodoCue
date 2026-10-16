import type { Task } from "@todocue/shared";
import { client } from "./bridge.js";
import { rescheduleToTomorrow } from "./dates.js";

/**
 * Task mutations that more than one surface offers (the detail page and the row context menu).
 * Each is a bare runtime call; callers add their own busy state, refresh and error handling.
 */
export const taskCommands = {
  snooze: (task: Task, minutes = 10) =>
    client.snoozeTask(task.id, { expectedVersion: task.version, minutes }),
  tomorrow: (task: Task, today: string) =>
    client.updateTask(task.id, rescheduleToTomorrow(task, today)),
  cancel: (task: Task) => client.cancelTask(task.id, { expectedVersion: task.version }),
  skip: (task: Task) => client.skipTask(task.id, { expectedVersion: task.version }),
  reopen: (task: Task) => client.reopenTask(task.id, { expectedVersion: task.version }),
  remove: (task: Task) => client.deleteTask(task.id, { expectedVersion: task.version }),
};
