import { isNotFound } from "./errors.js";

/**
 * Deleting something that is already gone is a success, as the native client treats it
 * (`AppModel.deleteTask`). Any other failure still propagates so the confirmation stays up.
 */
export async function removeTolerantly(remove: () => Promise<unknown>): Promise<"deleted" | "gone"> {
  try {
    await remove();
    return "deleted";
  } catch (error) {
    if (isNotFound(error)) return "gone";
    throw error;
  }
}

export interface RouteEntry {
  route: string;
  task?: { id: string };
  [extra: string]: unknown;
}

const TASK_ROUTES = ["detail", "form"];

/**
 * A deleted task leaves no page behind: its detail and edit pages come off the back stack, and if
 * the panel is showing one of them it steps back to what is left (the native `forget`).
 */
export function afterTaskDeleted<Entry extends RouteEntry>(
  current: { route: string; taskId?: string },
  stack: Entry[],
  taskId: string,
): { stack: Entry[]; leaveTo: Entry | null | undefined } {
  const kept = stack.filter((entry) => !(TASK_ROUTES.includes(entry.route) && entry.task?.id === taskId));
  const leaving = TASK_ROUTES.includes(current.route) && current.taskId === taskId;
  // `null` means "show the list"; `undefined` means the current page stays.
  return { stack: kept, leaveTo: leaving ? (kept.pop() ?? null) : undefined };
}
