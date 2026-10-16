import { TodoCueClient, type Board } from "@todocue/client";
import type { PeriodicReminder, RuntimeEvent, Task } from "@todocue/shared";

export interface Cue {
  key: string;
  id: string;
  title: string;
  repeats: number;
  receivedAt: number;
  task?: Task;
  periodic?: PeriodicReminder;
  dormant?: boolean;
}
export function visibleCues(cues: Cue[], featuredKey: string | null) {
  return cues.filter((cue, index) => index < 3 || cue.key === featuredKey);
}

/** Pure state logic, shared by both windows and exercised with the real runtime. */
export class CueStack {
  entries: Cue[] = [];
  private seen = new Map<string, number>();
  private reservations = new Set<string>();
  receive(cue: Omit<Cue, "repeats">, now = Date.now()): boolean {
    for (const [id, at] of this.seen)
      if (now - at >= 300000) this.seen.delete(id);
    const current = this.entries.find((item) => item.key === cue.key);
    if (current?.id === cue.id) {
      Object.assign(current, cue);
      return false;
    }
    if (this.seen.has(cue.id)) return false;
    if (!current && this.entries.length >= 20) return false;
    this.seen.set(cue.id, now);
    if (current) Object.assign(current, cue, { repeats: current.repeats + 1 });
    else this.entries.push({ ...cue, repeats: 1 });
    return true;
  }
  sync(tasks: Task[], rules: PeriodicReminder[]) {
    this.entries = this.entries.filter((cue) => {
      if (cue.task) {
        const task = tasks.find((task) => task.id === cue.task!.id);
        if (
          !task ||
          task.status !== "todo" ||
          task.reminderAt !== cue.task.reminderAt
        )
          return false;
        cue.task = task;
        cue.title = task.title;
      }
      if (cue.periodic) {
        const rule = rules.find((rule) => rule.id === cue.periodic!.id);
        if (
          !rule ||
          !rule.enabled ||
          rule.state.startsWith("paused") ||
          rule.currentOccurrence?.result !== "pending" ||
          !["offered", "claimed", "displayed", "submitted"].includes(
            rule.currentOccurrence.delivery,
          )
        )
          return false;
        cue.periodic = rule;
        cue.title = rule.title;
        cue.dormant = !periodicActive(rule);
      }
      return true;
    });
  }
  shown() {
    return this.entries
      .filter((cue) => !cue.dormant)
      .sort((a, b) =>
        Number(this.reservations.has(b.key)) - Number(this.reservations.has(a.key)) ||
        Number(!!b.task) - Number(!!a.task),
      );
  }
  canDisplay(key: string) {
    const rows = this.shown();
    const index = rows.findIndex((cue) => cue.key === key);
    const reserved = [...this.reservations].filter((key) => !rows.some((row) => row.key === key));
    return index >= 0 ? index + reserved.length < 3 : rows.length + reserved.length < 3;
  }
  /** Reserve before any await, so simultaneous offers cannot claim the same slot. */
  reserve(key: string) {
    if (this.reservations.has(key) || !this.canDisplay(key)) return false;
    this.reservations.add(key);
    return true;
  }
  release(key: string) {
    this.reservations.delete(key);
  }
}

/** All history refresh paths share one epoch, including mutation-triggered reloads. */
export class LatestRequest {
  private epoch = 0;
  invalidate() { this.epoch++; }
  async run<T>(load: () => Promise<T>, apply: (value: T) => void, fail: (error: unknown) => void) {
    const epoch = ++this.epoch;
    try {
      const value = await load();
      if (epoch === this.epoch) apply(value);
    } catch (error) {
      if (epoch === this.epoch) fail(error);
    }
  }
}
export function shouldCollapseQuickLook(reason: "outside" | "leave", state: { expanded: boolean; pinned: boolean; editing: boolean }) {
  return state.expanded && (reason === "outside" || (!state.pinned && !state.editing));
}

export function periodicActive(rule: PeriodicReminder, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: rule.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekday =
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
      value("weekday"),
    ) + 1;
  const time = `${value("hour")}:${value("minute")}`;
  return (
    rule.weekdays.includes(weekday) &&
    rule.windows.some((window) => time >= window.start && time < window.end)
  );
}

export function taskCue(
  event: RuntimeEvent,
  task: Task,
  now = Date.now(),
): Omit<Cue, "repeats"> | null {
  const age = now - Date.parse(event.at);
  if (
    event.type !== "reminder.fired" ||
    !event.id ||
    event.related?.taskId !== task.id ||
    task.status !== "todo" ||
    event.related.fireAt !== task.reminderAt ||
    age < -5000 ||
    age >= 120000
  )
    return null;
  return {
    key: `task:${task.id}`,
    id: event.id,
    title: task.title,
    receivedAt: now,
    task,
  };
}

/** Board revisions exclude stale HTTP snapshots arriving after newer mutations. */
export function latestBoard(current: Board | null, incoming: Board): Board {
  return current && current.ordering.revision > incoming.ordering.revision
    ? current
    : incoming;
}
export async function completeAfterFeedback(
  client: TodoCueClient,
  task: Task,
  feedback: () => Promise<void>,
) {
  await feedback();
  return client.completeTask(task.id, { expectedVersion: task.version });
}

/** A hover-deferred row and a cue hidden by quick-look must never acknowledge display. */
export function canPresentPeriodic({
  enabled,
  expanded,
  hovered,
  foreground,
}: {
  enabled: boolean;
  expanded: boolean;
  hovered: boolean;
  foreground: boolean;
}) {
  return enabled && !expanded && !hovered && foreground;
}
