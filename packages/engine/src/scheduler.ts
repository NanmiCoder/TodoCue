import type { Reminder, Task } from "@todocue/shared";
import type { TaskEngine } from "./engine.js";
import type { NotificationSink } from "./notifier.js";
import { formatLocal } from "./time.js";

export interface SchedulerOptions {
  engine: TaskEngine;
  notifier: NotificationSink;
  /** Polling interval in ms (default 5s; the plan requires delivery within 10s). */
  tickMs?: number;
  /** Reminders older than this at delivery time are treated as missed (default 2 min). */
  missedGraceMs?: number;
  /** Gap between ticks that indicates the machine slept (default 30s). */
  sleepGapMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  log?: (msg: string) => void;
}

/**
 * Drives reminder delivery and day rollover. All decisions are made from
 * persisted state so a restart never loses or duplicates reminders.
 */
export class Scheduler {
  private readonly engine: TaskEngine;
  private readonly notifier: NotificationSink;
  private readonly tickMs: number;
  private readonly missedGraceMs: number;
  private readonly sleepGapMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly log: (msg: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private lastTickAt: number | null = null;
  private lastDate: string;
  private running = false;
  private ticking: Promise<void> | null = null;

  constructor(opts: SchedulerOptions) {
    this.engine = opts.engine;
    this.notifier = opts.notifier;
    this.tickMs = opts.tickMs ?? 5_000;
    this.missedGraceMs = opts.missedGraceMs ?? 120_000;
    this.sleepGapMs = opts.sleepGapMs ?? 30_000;
    this.retryDelayMs = opts.retryDelayMs ?? 30_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.log = opts.log ?? (() => {});
    this.lastDate = this.engine.today();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.engine.ensureSeriesInstances();
    void this.tick(true);
    this.timer = setInterval(() => void this.tick(false), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run one scheduler pass. `catchUp` forces missed-reminder handling (startup / wake). */
  async tick(catchUp = false): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick(catchUp).finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick(catchUp: boolean): Promise<void> {
    const nowMs = this.engine.now().getTime();
    const wokeUp = this.lastTickAt !== null && nowMs - this.lastTickAt > this.sleepGapMs;
    this.lastTickAt = nowMs;
    if (wokeUp) this.log(`detected sleep/wake gap; catching up missed reminders`);

    const today = this.engine.today();
    if (today !== this.lastDate) {
      this.lastDate = today;
      const n = this.engine.ensureSeriesInstances();
      this.engine.emit("day.changed", today);
      this.log(`day changed to ${today}; generated ${n} recurring instances`);
    }

    const due = this.engine.dueReminders();
    if (due.length === 0) return;
    const nowIso = this.engine.nowIso();
    const tasks = this.engine.tasksById(due.map((r) => r.taskId));

    // Split into on-time and missed (older than grace or detected after wake/startup).
    const onTime: Reminder[] = [];
    const missed: Reminder[] = [];
    for (const r of due) {
      const task = tasks.get(r.taskId);
      if (!task || task.status !== "todo" || task.reminderAt !== r.fireAt) {
        // Task changed underneath the reminder: never deliver stale reminders.
        this.engine.markReminderFailed(r.id, "task state changed before delivery");
        continue;
      }
      const ageMs = nowMs - new Date(r.fireAt).getTime();
      if ((catchUp || wokeUp) && ageMs > this.missedGraceMs) missed.push(r);
      else if (ageMs > this.missedGraceMs) missed.push(r);
      else onTime.push(r);
    }

    for (const r of onTime) {
      const task = tasks.get(r.taskId)!;
      await this.deliverOne(r, task);
    }

    if (missed.length === 1) {
      const r = missed[0]!;
      await this.deliverOne(r, tasks.get(r.taskId)!, true);
    } else if (missed.length > 1) {
      await this.deliverSummary(missed, tasks, nowIso);
    }
  }

  private async deliverOne(r: Reminder, task: Task, late = false): Promise<void> {
    // Recheck after previous async deliveries: edits/cancellation can invalidate a queued reminder.
    const current = this.engine.getTask(task.id);
    if (current.status !== "todo" || current.reminderAt !== r.fireAt) return;
    task = current;
    this.engine.emitReminderCue([r.id], late);
    const when = formatLocal(r.fireAt, task.timezone, "HH:mm");
    const lines: string[] = [];
    if (late) lines.push(`错过的提醒（${formatLocal(r.fireAt, task.timezone, "M月d日 HH:mm")}）`);
    if (task.project) lines.push(`项目：${task.project}`);
    if (task.dueAt) lines.push(`截止 ${formatLocal(task.dueAt, task.timezone, "M月d日 HH:mm")}`);
    else if (task.dueDate) lines.push(`截止 ${task.dueDate}`);
    if (task.notes) lines.push(task.notes.split("\n")[0]!.slice(0, 120));
    try {
      const channel = await this.notifier.deliver({
        id: task.id,
        title: task.title,
        subtitle: late ? undefined : `提醒 · ${when}`,
        body: lines.join("\n") || undefined,
        taskId: task.id,
        thread: "todocue.reminders",
      });
      this.engine.markReminderSubmitted(r.id, channel, late ? "missed" : "submitted");
      this.log(`reminder ${r.id} for ${task.id} submitted via ${channel}${late ? " (late)" : ""}`);
    } catch (e) {
      const msg = (e as Error).message;
      this.engine.markReminderFailed(r.id, msg, { retryInMs: this.retryDelayMs, maxAttempts: this.maxAttempts });
      this.log(`reminder ${r.id} failed: ${msg}`);
    }
  }

  private async deliverSummary(missed: Reminder[], tasks: Map<string, Task>, nowIso: string): Promise<void> {
    this.engine.emitReminderCue(missed.map((r) => r.id), true);
    const titles = missed.map((r) => tasks.get(r.taskId)?.title ?? r.taskId);
    const shown = titles.slice(0, 4).map((t) => `• ${t}`);
    if (titles.length > 4) shown.push(`… 及另外 ${titles.length - 4} 项`);
    try {
      const channel = await this.notifier.deliver({
        id: `todocue-missed-${nowIso}`,
        title: `错过了 ${missed.length} 条提醒`,
        body: shown.join("\n"),
        thread: "todocue.reminders",
      });
      for (const r of missed) this.engine.markReminderSubmitted(r.id, `summary:${channel}`, "missed");
      this.log(`delivered summary for ${missed.length} missed reminders via ${channel}`);
    } catch (e) {
      const msg = (e as Error).message;
      for (const r of missed) this.engine.markReminderFailed(r.id, msg, { retryInMs: this.retryDelayMs, maxAttempts: this.maxAttempts });
      this.log(`missed-reminder summary failed: ${msg}`);
    }
  }
}
