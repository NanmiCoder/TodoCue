import type { Task } from "@todocue/shared";
import { dateOf } from "./dates.js";

/** Grouping and paging for the completed-work history (the native client's `CompletedHistory`). */
export const COMPLETED_PAGE = 60;
/** `ListTasksQuery.limit` is capped at 1000, so this is as far back as the history can reach. */
export const COMPLETED_MAX = 1000;

/** Rows to ask for: one past the window to learn whether more exist, never above the cap. */
export function probe(window: number): number {
  return Math.min(Math.max(window, 1) + 1, COMPLETED_MAX);
}

/** At the ceiling the probe cannot see past it, so this is knowingly false there. */
export function hasMore(window: number, received: number): boolean {
  return window < COMPLETED_MAX && received > window;
}

export function growWindow(window: number): number {
  return Math.min(window + COMPLETED_PAGE, COMPLETED_MAX);
}

/** The day a task was finished on, in the runtime's zone. */
export function completionDate(task: Task, timezone: string): string {
  return dateOf(task.completedAt ?? task.updatedAt, timezone);
}

export interface CompletedDay {
  date: string;
  tasks: Task[];
}

/** Days newest first, keeping the runtime's order (newest completed first) inside each day. */
export function completedDays(tasks: Task[], timezone: string): CompletedDay[] {
  const byDate = new Map<string, Task[]>();
  for (const task of tasks) {
    const date = completionDate(task, timezone);
    byDate.set(date, [...(byDate.get(date) ?? []), task]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, list]) => ({ date, tasks: list }));
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Case- and diacritic-insensitive match over the fields a person would search by. */
export function matchingCompleted(tasks: Task[], query: string): Task[] {
  const term = fold(query.trim());
  if (!term) return tasks;
  return tasks.filter((task) => [task.title, task.project ?? "", task.notes ?? ""].some((value) => fold(value).includes(term)));
}
