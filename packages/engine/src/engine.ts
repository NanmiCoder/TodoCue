import {
  CreateSeriesInput,
  CreateTaskInput,
  ListRemindersQuery,
  ListTasksQuery,
  RUNTIME_VERSION,
  SnoozeInput,
  TodoCueError,
  UpdateTaskInput,
  priorityRank,
  type ContextInfo,
  type ExportBundle,
  type NextCandidate,
  type NextGroup,
  type Reminder,
  type RuntimeEvent,
  type Series,
  type Task,
  type TodayItem,
  type TodayReason,
  type TodayResult,
  type NextResult,
  type EventType,
} from "@todocue/shared";
import { AttachmentStore } from "./attachments.js";
import type { SqliteDatabase } from "./db.js";
import { newReminderId, newSeriesId, newTaskId } from "./ids.js";
import {
  reminderFromRow,
  seriesFromRow,
  seriesToRow,
  taskFromRow,
  taskToRow,
  type ReminderRow,
  type SeriesRow,
  type TaskRow,
} from "./rows.js";
import {
  addDays,
  assertTimezone,
  compareDates,
  formatLocal,
  localDateOf,
  localDateTimeToUtc,
  localIsoOf,
  parseInstant,
  systemClock,
  systemTimezone,
  toUtcIso,
  weekdayOf,
  type Clock,
} from "./time.js";

export interface EngineOptions {
  db: SqliteDatabase;
  clock?: Clock;
  /** Overrides the persisted timezone (also persists it). */
  timezone?: string;
  /** How many days ahead recurring instances are generated. */
  horizonDays?: number;
}

export type EventListener = (event: RuntimeEvent) => void;

interface PendingEvent {
  type: EventType;
  id: string | null;
  related?: Record<string, string>;
}

const SNOOZE_DEFAULT_MINUTES = 10;

export class TaskEngine {
  readonly db: SqliteDatabase;
  readonly clock: Clock;
  readonly timezone: string;
  readonly horizonDays: number;
  readonly attachments: AttachmentStore;

  private listeners = new Set<EventListener>();
  private seq = 0;
  private txDepth = 0;
  private pendingEvents: PendingEvent[] = [];

  constructor(opts: EngineOptions) {
    this.db = opts.db;
    this.attachments = new AttachmentStore(this.db);
    this.clock = opts.clock ?? systemClock;
    this.horizonDays = opts.horizonDays ?? 30;
    this.timezone = this.resolveTimezone(opts.timezone);
  }

  // ---------------------------------------------------------------------
  // Settings / context
  // ---------------------------------------------------------------------

  private resolveTimezone(override?: string): string {
    if (override) {
      assertTimezone(override);
      this.setSetting("timezone", override);
      return override;
    }
    const stored = this.getSetting("timezone");
    if (stored) return stored;
    const tz = systemTimezone();
    this.setSetting("timezone", tz);
    return tz;
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  now(): Date {
    return this.clock.now();
  }

  nowIso(): string {
    return toUtcIso(this.now());
  }

  today(): string {
    return localDateOf(this.now(), this.timezone);
  }

  context(): ContextInfo {
    const now = this.now();
    const today = localDateOf(now, this.timezone);
    return {
      now: toUtcIso(now),
      timezone: this.timezone,
      today,
      localNow: localIsoOf(now, this.timezone),
      weekday: weekdayOf(today),
      runtimeVersion: RUNTIME_VERSION,
    };
  }

  // ---------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emit an event outside of any entity transaction (e.g. day change). */
  emit(type: EventType, id: string | null = null, related?: Record<string, string>): void {
    this.queueEvent({ type, id, related });
    if (this.txDepth === 0) this.flushEvents();
  }

  private queueEvent(e: PendingEvent): void {
    this.pendingEvents.push(e);
  }

  private flushEvents(): void {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    const at = this.nowIso();
    for (const e of events) {
      const ev: RuntimeEvent = { seq: ++this.seq, type: e.type, at, id: e.id };
      if (e.related) ev.related = e.related;
      for (const l of this.listeners) {
        try {
          l(ev);
        } catch {
          /* listener errors must not break the engine */
        }
      }
    }
  }

  /** Run fn in a transaction; events are delivered after commit. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.txDepth++;
    try {
      const run = this.db.transaction(fn);
      const result = run();
      this.txDepth--;
      this.flushEvents();
      return result;
    } catch (e) {
      this.txDepth--;
      this.pendingEvents = [];
      throw e;
    }
  }

  // ---------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------

  private taskRow(id: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  }

  private requireTask(id: string): Task {
    const row = this.taskRow(id);
    if (!row) throw TodoCueError.notFound("task", id);
    return this.hydrateTask(row);
  }

  private hydrateTask = (row: TaskRow): Task => ({ ...taskFromRow(row), attachments: this.attachments.list(row.id) });

  getTask(id: string): Task {
    return this.requireTask(id);
  }

  getTaskDetail(id: string): { task: Task; series: Series | null; reminder: Reminder | null } {
    const task = this.requireTask(id);
    const series = task.seriesId ? this.getSeries(task.seriesId) : null;
    const reminderRow = this.db
      .prepare("SELECT * FROM reminders WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(id) as ReminderRow | undefined;
    return { task, series, reminder: reminderRow ? reminderFromRow(reminderRow) : null };
  }

  private insertTask(task: Task): void {
    const r = taskToRow(task);
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, notes, project, priority, estimate_minutes, scheduled_date, scheduled_at,
          due_date, due_at, reminder_at, timezone, status, completed_at, series_id, occurrence_date, version, created_at, updated_at)
         VALUES (@id, @title, @notes, @project, @priority, @estimate_minutes, @scheduled_date, @scheduled_at,
          @due_date, @due_at, @reminder_at, @timezone, @status, @completed_at, @series_id, @occurrence_date, @version, @created_at, @updated_at)`,
      )
      .run(r);
  }

  private writeTask(task: Task): void {
    const r = taskToRow(task);
    this.db
      .prepare(
        `UPDATE tasks SET title=@title, notes=@notes, project=@project, priority=@priority, estimate_minutes=@estimate_minutes,
          scheduled_date=@scheduled_date, scheduled_at=@scheduled_at, due_date=@due_date, due_at=@due_at, reminder_at=@reminder_at,
          timezone=@timezone, status=@status, completed_at=@completed_at, series_id=@series_id, occurrence_date=@occurrence_date,
          version=@version, created_at=@created_at, updated_at=@updated_at WHERE id=@id`,
      )
      .run(r);
  }

  private checkVersion(entity: { id: string; version: number }, expected: number | undefined): void {
    if (expected !== undefined && expected !== entity.version) {
      throw TodoCueError.conflict(entity.id, expected, entity.version);
    }
  }

  /**
   * Apply plan/due/reminder inputs onto a task draft, enforcing exclusivity
   * and parsing instants in the task timezone.
   */
  private applyTimeFields(
    draft: Task,
    input: Pick<UpdateTaskInput, "scheduledDate" | "scheduledAt" | "dueDate" | "dueAt" | "reminderAt">,
  ): void {
    const tz = draft.timezone;
    if (input.scheduledDate != null && input.scheduledAt != null) {
      throw TodoCueError.validation("scheduledDate and scheduledAt are mutually exclusive");
    }
    if (input.dueDate != null && input.dueAt != null) {
      throw TodoCueError.validation("dueDate and dueAt are mutually exclusive");
    }
    if (input.scheduledDate !== undefined) {
      draft.scheduledDate = input.scheduledDate;
      if (input.scheduledDate !== null) draft.scheduledAt = null;
    }
    if (input.scheduledAt !== undefined) {
      draft.scheduledAt = input.scheduledAt === null ? null : parseInstant(input.scheduledAt, tz, "scheduledAt");
      if (input.scheduledAt !== null) draft.scheduledDate = null;
    }
    if (input.dueDate !== undefined) {
      draft.dueDate = input.dueDate;
      if (input.dueDate !== null) draft.dueAt = null;
    }
    if (input.dueAt !== undefined) {
      draft.dueAt = input.dueAt === null ? null : parseInstant(input.dueAt, tz, "dueAt");
      if (input.dueAt !== null) draft.dueDate = null;
    }
    if (input.reminderAt !== undefined) {
      draft.reminderAt = input.reminderAt === null ? null : parseInstant(input.reminderAt, tz, "reminderAt");
    }
  }

  createTask(rawInput: CreateTaskInput): { task: Task; series: Series | null } {
    const input = CreateTaskInput.parse(rawInput);
    return this.tx(() => {
      const result = this.createTaskRecord(input);
      if (input.attachments?.length) {
        // Recurrence attachments belong to the first instance, never implicitly to future tasks.
        this.attachments.add(result.task.id, input.attachments, this.nowIso());
        result.task.attachments = this.attachments.list(result.task.id);
      }
      return result;
    });
  }

  private createTaskRecord(rawInput: CreateTaskInput): { task: Task; series: Series | null } {
    const input = CreateTaskInput.parse(rawInput);
    if (input.repeat) return this.createRepeatingTask(input);
    const tz = input.timezone ? assertTimezone(input.timezone) : this.timezone;
    const nowIso = this.nowIso();
    const draft: Task = {
      attachments: [],
      id: newTaskId(),
      title: input.title,
      notes: input.notes ?? null,
      project: emptyToNull(input.project),
      priority: input.priority ?? "none",
      estimateMinutes: input.estimateMinutes ?? null,
      scheduledDate: null,
      scheduledAt: null,
      dueDate: null,
      dueAt: null,
      reminderAt: null,
      timezone: tz,
      status: "todo",
      completedAt: null,
      seriesId: null,
      occurrenceDate: null,
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.applyTimeFields(draft, input);
    return this.tx(() => {
      this.insertTask(draft);
      this.queueEvent({ type: "task.created", id: draft.id });
      this.syncReminder(draft);
      return { task: draft, series: null };
    });
  }

  private createRepeatingTask(input: CreateTaskInput): { task: Task; series: Series } {
    const tz = input.timezone ? assertTimezone(input.timezone) : this.timezone;
    const rule = input.repeat!;
    let scheduledTime: string | null = input.scheduledTime ?? null;
    let startDate: string | null = input.startDate ?? input.scheduledDate ?? null;
    if (input.scheduledAt) {
      const iso = parseInstant(input.scheduledAt, tz, "scheduledAt");
      scheduledTime ??= formatLocal(iso, tz, "HH:mm");
      startDate ??= localDateOf(iso, tz);
    }
    let reminderTime: string | null = input.reminderTime ?? null;
    if (!reminderTime && input.reminderAt) {
      reminderTime = formatLocal(parseInstant(input.reminderAt, tz, "reminderAt"), tz, "HH:mm");
    }
    const created = this.createSeries({
      title: input.title,
      notes: input.notes ?? null,
      project: input.project ?? null,
      priority: input.priority ?? "none",
      estimateMinutes: input.estimateMinutes ?? null,
      rule,
      scheduledTime,
      reminderTime,
      timezone: tz,
      startDate: startDate ?? this.today(),
      endDate: input.endDate ?? null,
    });
    const first = created.tasks[0];
    if (!first) {
      throw TodoCueError.validation("repeat rule produces no instances in the next 30 days", { rule });
    }
    return { task: first, series: created.series };
  }

  updateTask(id: string, rawPatch: UpdateTaskInput): Task {
    const patch = UpdateTaskInput.parse(rawPatch);
    return this.tx(() => {
      const task = this.requireTask(id);
      this.checkVersion(task, patch.expectedVersion);
      const draft: Task = { ...task };
      if (patch.timezone !== undefined) draft.timezone = assertTimezone(patch.timezone);
      if (patch.title !== undefined) draft.title = patch.title;
      if (patch.notes !== undefined) draft.notes = patch.notes;
      if (patch.project !== undefined) draft.project = emptyToNull(patch.project);
      if (patch.priority !== undefined) draft.priority = patch.priority;
      if (patch.estimateMinutes !== undefined) draft.estimateMinutes = patch.estimateMinutes;
      this.applyTimeFields(draft, patch);
      if (patch.removeAttachmentIds?.length) this.attachments.remove(id, patch.removeAttachmentIds);
      if (patch.addAttachments?.length) this.attachments.add(id, patch.addAttachments, this.nowIso());
      draft.attachments = this.attachments.list(id);
      this.bump(draft);
      this.writeTask(draft);
      this.queueEvent({ type: "task.updated", id: draft.id });
      this.syncReminder(draft);
      return draft;
    });
  }

  private bump(task: Task): void {
    task.version += 1;
    task.updatedAt = this.nowIso();
  }

  completeTask(id: string, opts: { expectedVersion?: number } = {}): Task {
    return this.tx(() => {
      const task = this.requireTask(id);
      this.checkVersion(task, opts.expectedVersion);
      if (task.status === "done") return task;
      if (task.status === "cancelled" || task.status === "skipped") {
        throw TodoCueError.invalidState(`task ${id} is ${task.status}; reopen it first`, { id, status: task.status });
      }
      const draft: Task = { ...task, status: "done", completedAt: this.nowIso() };
      this.bump(draft);
      this.writeTask(draft);
      this.queueEvent({ type: "task.updated", id });
      this.cancelPendingReminders(id);
      return draft;
    });
  }

  reopenTask(id: string, opts: { expectedVersion?: number } = {}): Task {
    return this.tx(() => {
      const task = this.requireTask(id);
      this.checkVersion(task, opts.expectedVersion);
      if (task.status === "todo") return task;
      const draft: Task = { ...task, status: "todo", completedAt: null };
      this.bump(draft);
      this.writeTask(draft);
      // Undo must not re-send reminders whose time already passed.
      this.queueEvent({ type: "task.updated", id });
      if (draft.reminderAt && draft.reminderAt > this.nowIso()) this.syncReminder(draft);
      return draft;
    });
  }

  cancelTask(id: string, opts: { expectedVersion?: number } = {}): Task {
    return this.tx(() => {
      const task = this.requireTask(id);
      this.checkVersion(task, opts.expectedVersion);
      if (task.status === "cancelled") return task;
      if (task.status === "done") {
        throw TodoCueError.invalidState(`task ${id} is already done`, { id, status: task.status });
      }
      const draft: Task = { ...task, status: "cancelled" };
      this.bump(draft);
      this.writeTask(draft);
      this.queueEvent({ type: "task.updated", id });
      this.cancelPendingReminders(id);
      return draft;
    });
  }

  skipTask(id: string, opts: { expectedVersion?: number } = {}): Task {
    return this.tx(() => {
      const task = this.requireTask(id);
      this.checkVersion(task, opts.expectedVersion);
      if (!task.seriesId) {
        throw TodoCueError.invalidState(`task ${id} is not a repeating instance; skip applies to series instances only`, { id });
      }
      if (task.status === "skipped") return task;
      if (task.status !== "todo") {
        throw TodoCueError.invalidState(`task ${id} is ${task.status}`, { id, status: task.status });
      }
      const draft: Task = { ...task, status: "skipped" };
      this.bump(draft);
      this.writeTask(draft);
      this.queueEvent({ type: "task.updated", id });
      this.cancelPendingReminders(id);
      return draft;
    });
  }

  snoozeTask(id: string, rawInput: SnoozeInput = {}): Task {
    const input = SnoozeInput.parse(rawInput);
    return this.tx(() => {
      const task = this.requireTask(id);
      this.checkVersion(task, input.expectedVersion);
      if (task.status !== "todo") {
        throw TodoCueError.invalidState(`task ${id} is ${task.status}; only open tasks can be snoozed`, { id, status: task.status });
      }
      const now = this.now();
      const until = input.until
        ? parseInstant(input.until, task.timezone, "until")
        : toUtcIso(new Date(now.getTime() + (input.minutes ?? SNOOZE_DEFAULT_MINUTES) * 60_000));
      if (until <= toUtcIso(now)) throw TodoCueError.validation("snooze time must be in the future", { until });
      const draft: Task = { ...task, reminderAt: until };
      this.bump(draft);
      this.writeTask(draft);
      this.queueEvent({ type: "task.updated", id });
      this.syncReminder(draft);
      return draft;
    });
  }

  listTasks(rawQuery: ListTasksQuery = {}): Task[] {
    const q = ListTasksQuery.parse(rawQuery);
    this.ensureSeriesInstances();
    const where: string[] = [];
    const params: unknown[] = [];
    const statuses = q.status === undefined ? ["todo"] : Array.isArray(q.status) ? q.status : [q.status];
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
    if (q.project !== undefined) {
      where.push("project = ?");
      params.push(q.project);
    }
    if (q.seriesId !== undefined) {
      where.push("series_id = ?");
      params.push(q.seriesId);
    }
    if (q.q) {
      where.push("(title LIKE ? OR notes LIKE ?)");
      const like = `%${q.q}%`;
      params.push(like, like);
    }
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY created_at ASC`)
      .all(...params) as TaskRow[];
    let tasks = rows.map(this.hydrateTask);
    const includeUnscheduled = q.includeUnscheduled ?? true;
    if (q.from || q.to || !includeUnscheduled) {
      tasks = tasks.filter((t) => {
        const d = this.planDate(t);
        if (!d) return includeUnscheduled && !q.from && !q.to;
        if (q.from && compareDates(d, q.from) < 0) return false;
        if (q.to && compareDates(d, q.to) > 0) return false;
        return true;
      });
    }
    const now = this.now();
    const today = localDateOf(now, this.timezone);
    tasks.sort((a, b) => this.compareTasks(a, b, now, today));
    if (q.limit) tasks = tasks.slice(0, q.limit);
    return tasks;
  }

  /** Earliest local date the task "belongs" to (plan or due). */
  private planDate(t: Task): string | null {
    const dates: string[] = [];
    if (t.scheduledDate) dates.push(t.scheduledDate);
    if (t.scheduledAt) dates.push(localDateOf(t.scheduledAt, t.timezone));
    if (t.dueDate) dates.push(t.dueDate);
    if (t.dueAt) dates.push(localDateOf(t.dueAt, t.timezone));
    if (dates.length === 0) return null;
    dates.sort();
    return dates[0]!;
  }

  // ---------------------------------------------------------------------
  // Ordering / today / next
  // ---------------------------------------------------------------------

  private dueKey(t: Task): string | null {
    if (t.dueAt) return t.dueAt;
    if (t.dueDate) return `${t.dueDate}T99`; // date-level due sorts after instants on the same day
    return null;
  }

  private isOverdue(t: Task, nowIso: string, today: string): boolean {
    if (t.dueAt) return t.dueAt < nowIso;
    if (t.dueDate) return compareDates(t.dueDate, today) < 0;
    return false;
  }

  private isDueToday(t: Task, today: string): boolean {
    if (t.dueAt) return localDateOf(t.dueAt, t.timezone) === today;
    if (t.dueDate) return t.dueDate === today;
    return false;
  }

  private scheduledReached(t: Task, nowIso: string, today: string): boolean {
    if (t.scheduledAt) return t.scheduledAt <= nowIso;
    if (t.scheduledDate) return compareDates(t.scheduledDate, today) <= 0;
    return false;
  }

  private scheduledInFuture(t: Task, nowIso: string, today: string): boolean {
    if (t.scheduledAt) return t.scheduledAt > nowIso;
    if (t.scheduledDate) return compareDates(t.scheduledDate, today) > 0;
    return false;
  }

  private groupOf(t: Task, nowIso: string, today: string): NextGroup {
    if (this.isOverdue(t, nowIso, today)) return "overdue";
    if (this.isDueToday(t, today)) return "due_today";
    if (this.scheduledReached(t, nowIso, today)) return "scheduled_reached";
    return "unscheduled";
  }

  private static groupRank: Record<NextGroup, number> = { overdue: 0, due_today: 1, scheduled_reached: 2, unscheduled: 3 };
  private static statusRank: Record<Task["status"], number> = { todo: 0, done: 1, skipped: 2, cancelled: 3 };

  private compareTasks(a: Task, b: Task, now: Date, today: string): number {
    const nowIso = toUtcIso(now);
    if (a.status !== b.status) return TaskEngine.statusRank[a.status] - TaskEngine.statusRank[b.status];
    if (a.status !== "todo") return (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt);
    // Future-scheduled tasks sort after everything currently actionable, by their plan date.
    const fa = this.scheduledInFuture(a, nowIso, today);
    const fb = this.scheduledInFuture(b, nowIso, today);
    if (fa !== fb) return fa ? 1 : -1;
    if (fa && fb) {
      const pa = this.planDate(a) ?? "", pb = this.planDate(b) ?? "";
      if (pa !== pb) return pa < pb ? -1 : 1;
    }
    const ga = TaskEngine.groupRank[this.groupOf(a, nowIso, today)];
    const gb = TaskEngine.groupRank[this.groupOf(b, nowIso, today)];
    if (ga !== gb) return ga - gb;
    const pr = priorityRank[b.priority] - priorityRank[a.priority];
    if (pr !== 0) return pr;
    const da = this.dueKey(a), db = this.dueKey(b);
    if (da !== db) {
      if (da === null) return 1;
      if (db === null) return -1;
      return da < db ? -1 : 1;
    }
    const pa = this.planDate(a), pb = this.planDate(b);
    if (pa !== pb) {
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pa < pb ? -1 : 1;
    }
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id.localeCompare(b.id);
  }

  private openTasks(): Task[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE status = 'todo'").all() as TaskRow[];
    return rows.map(this.hydrateTask);
  }

  todayView(): TodayResult {
    this.ensureSeriesInstances();
    const now = this.now();
    const nowIso = toUtcIso(now);
    const today = localDateOf(now, this.timezone);
    const items: TodayItem[] = [];
    for (const t of this.openTasks()) {
      const reasons: TodayReason[] = [];
      if (this.isOverdue(t, nowIso, today)) reasons.push("overdue");
      else if (this.isDueToday(t, today)) reasons.push("due_today");
      const sd = t.scheduledDate ?? (t.scheduledAt ? localDateOf(t.scheduledAt, t.timezone) : null);
      if (sd === today) reasons.push("scheduled_today");
      else if (sd && compareDates(sd, today) < 0) reasons.push("carried_over");
      if (reasons.length === 0) continue;
      const section = reasons.includes("overdue") ? "overdue" : reasons.includes("due_today") ? "must" : "scheduled";
      items.push({ task: t, reasons, section });
    }
    const sectionRank = { overdue: 0, must: 1, scheduled: 2 } as const;
    items.sort((a, b) => sectionRank[a.section] - sectionRank[b.section] || this.compareTasks(a.task, b.task, now, today));
    const completedRows = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'done' AND completed_at IS NOT NULL ORDER BY completed_at DESC")
      .all() as TaskRow[];
    const completed = completedRows.map(this.hydrateTask).filter((t) => localDateOf(t.completedAt!, this.timezone) === today);
    return { date: today, timezone: this.timezone, now: nowIso, remaining: items.length, items, completed };
  }

  nextView(): NextResult {
    this.ensureSeriesInstances();
    const now = this.now();
    const nowIso = toUtcIso(now);
    const today = localDateOf(now, this.timezone);
    const candidates: NextCandidate[] = [];
    for (const t of this.openTasks()) {
      if (this.scheduledInFuture(t, nowIso, today)) continue;
      const group = this.groupOf(t, nowIso, today);
      candidates.push({ task: t, group, reason: this.describeReason(t, group, today) });
    }
    candidates.sort((a, b) => this.compareTasks(a.task, b.task, now, today));
    return { now: nowIso, timezone: this.timezone, next: candidates[0] ?? null, candidates };
  }

  private describeReason(t: Task, group: NextGroup, today: string): string {
    const tz = t.timezone;
    switch (group) {
      case "overdue":
        return t.dueAt ? `已逾期，截止 ${formatLocal(t.dueAt, tz, "M月d日 HH:mm")}` : `已逾期，截止 ${humanDate(t.dueDate!, today)}`;
      case "due_today":
        return t.dueAt ? `今天 ${formatLocal(t.dueAt, tz, "HH:mm")} 截止` : "今天截止";
      case "scheduled_reached":
        if (t.scheduledAt) {
          const d = localDateOf(t.scheduledAt, tz);
          return d === today ? `计划 ${formatLocal(t.scheduledAt, tz, "HH:mm")} 开始` : `${humanDate(d, today)}的计划尚未完成`;
        }
        return t.scheduledDate === today ? "今天计划处理" : `${humanDate(t.scheduledDate!, today)}的计划尚未完成`;
      case "unscheduled":
        if (t.dueAt) return `截止 ${formatLocal(t.dueAt, tz, "M月d日 HH:mm")}，未安排时间`;
        if (t.dueDate) return `截止 ${humanDate(t.dueDate, today)}，未安排时间`;
        return "未安排时间";
    }
  }

  // ---------------------------------------------------------------------
  // Series
  // ---------------------------------------------------------------------

  private seriesRow(id: string): SeriesRow | undefined {
    return this.db.prepare("SELECT * FROM series WHERE id = ?").get(id) as SeriesRow | undefined;
  }

  getSeries(id: string): Series {
    const row = this.seriesRow(id);
    if (!row) throw TodoCueError.notFound("series", id);
    return seriesFromRow(row);
  }

  listSeries(opts: { status?: Series["status"] } = {}): Series[] {
    const rows = (
      opts.status
        ? this.db.prepare("SELECT * FROM series WHERE status = ? ORDER BY created_at").all(opts.status)
        : this.db.prepare("SELECT * FROM series ORDER BY created_at").all()
    ) as SeriesRow[];
    return rows.map(seriesFromRow);
  }

  getSeriesTasks(seriesId: string): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE series_id = ? ORDER BY occurrence_date ASC")
      .all(seriesId) as TaskRow[];
    return rows.map(this.hydrateTask);
  }

  private writeSeries(s: Series, insert: boolean): void {
    const r = seriesToRow(s);
    if (insert) {
      this.db
        .prepare(
          `INSERT INTO series (id, title, notes, project, priority, estimate_minutes, rule_kind, weekdays, scheduled_time, reminder_time,
             timezone, start_date, end_date, status, stopped_at, generated_through, version, created_at, updated_at)
           VALUES (@id, @title, @notes, @project, @priority, @estimate_minutes, @rule_kind, @weekdays, @scheduled_time, @reminder_time,
             @timezone, @start_date, @end_date, @status, @stopped_at, @generated_through, @version, @created_at, @updated_at)`,
        )
        .run(r);
    } else {
      this.db
        .prepare(
          `UPDATE series SET title=@title, notes=@notes, project=@project, priority=@priority, estimate_minutes=@estimate_minutes,
             rule_kind=@rule_kind, weekdays=@weekdays, scheduled_time=@scheduled_time, reminder_time=@reminder_time, timezone=@timezone,
             start_date=@start_date, end_date=@end_date, status=@status, stopped_at=@stopped_at, generated_through=@generated_through,
             version=@version, created_at=@created_at, updated_at=@updated_at WHERE id=@id`,
        )
        .run(r);
    }
  }

  createSeries(rawInput: CreateSeriesInput): { series: Series; tasks: Task[] } {
    const input = CreateSeriesInput.parse(rawInput);
    const tz = input.timezone ? assertTimezone(input.timezone) : this.timezone;
    if (input.endDate && input.startDate && compareDates(input.endDate, input.startDate) < 0) {
      throw TodoCueError.validation("endDate must not be before startDate");
    }
    const nowIso = this.nowIso();
    const series: Series = {
      id: newSeriesId(),
      title: input.title,
      notes: input.notes ?? null,
      project: emptyToNull(input.project),
      priority: input.priority ?? "none",
      estimateMinutes: input.estimateMinutes ?? null,
      rule: input.rule.kind === "weekly" ? { kind: "weekly", weekdays: [...new Set(input.rule.weekdays)].sort((a, b) => a - b) } : { kind: "daily" },
      scheduledTime: input.scheduledTime ?? null,
      reminderTime: input.reminderTime ?? null,
      timezone: tz,
      startDate: input.startDate ?? this.today(),
      endDate: input.endDate ?? null,
      status: "active",
      stoppedAt: null,
      generatedThrough: null,
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    return this.tx(() => {
      this.writeSeries(series, true);
      this.queueEvent({ type: "series.created", id: series.id });
      const tasks = this.generateInstances(series);
      return { series: this.getSeries(series.id), tasks };
    });
  }

  stopSeries(id: string, opts: { expectedVersion?: number } = {}): { series: Series; cancelledTaskIds: string[] } {
    return this.tx(() => {
      const series = this.getSeries(id);
      this.checkVersion(series, opts.expectedVersion);
      if (series.status === "stopped") return { series, cancelledTaskIds: [] };
      const today = this.today();
      const draft: Series = { ...series, status: "stopped", stoppedAt: this.nowIso(), version: series.version + 1, updatedAt: this.nowIso() };
      this.writeSeries(draft, false);
      this.queueEvent({ type: "series.updated", id });
      // Cancel instances that have not started (occurrence after today); keep today's and history.
      const rows = this.db
        .prepare("SELECT * FROM tasks WHERE series_id = ? AND status = 'todo' AND occurrence_date > ?")
        .all(id, today) as TaskRow[];
      const cancelled: string[] = [];
      for (const row of rows) {
        const t = this.hydrateTask(row);
        const c: Task = { ...t, status: "cancelled" };
        this.bump(c);
        this.writeTask(c);
        this.cancelPendingReminders(c.id);
        this.queueEvent({ type: "task.updated", id: c.id });
        cancelled.push(c.id);
      }
      return { series: draft, cancelledTaskIds: cancelled };
    });
  }

  /** Top up recurring instances for all active series. Returns number created. */
  ensureSeriesInstances(): number {
    const active = this.listSeries({ status: "active" });
    if (active.length === 0) return 0;
    const horizonEnd = addDays(this.today(), this.horizonDays);
    const needing = active.filter((s) => !s.generatedThrough || compareDates(s.generatedThrough, horizonEnd) < 0);
    if (needing.length === 0) return 0;
    return this.tx(() => needing.reduce((n, s) => n + this.generateInstances(s).length, 0));
  }

  private matchesRule(series: Series, date: string): boolean {
    if (series.rule.kind === "daily") return true;
    return series.rule.weekdays.includes(weekdayOf(date));
  }

  private generateInstances(series: Series): Task[] {
    const today = this.today();
    const nowIso = this.nowIso();
    let from = series.generatedThrough ? addDays(series.generatedThrough, 1) : series.startDate;
    if (compareDates(from, today) < 0) from = today;
    let to = addDays(today, this.horizonDays);
    if (series.endDate && compareDates(series.endDate, to) < 0) to = series.endDate;
    const created: Task[] = [];
    if (compareDates(from, to) > 0) {
      if (!series.generatedThrough || compareDates(series.generatedThrough, to) < 0) {
        this.db.prepare("UPDATE series SET generated_through = ? WHERE id = ?").run(to, series.id);
      }
      return created;
    }
    const exists = this.db.prepare("SELECT 1 FROM tasks WHERE series_id = ? AND occurrence_date = ?");
    for (let d = from; compareDates(d, to) <= 0; d = addDays(d, 1)) {
      if (!this.matchesRule(series, d)) continue;
      if (exists.get(series.id, d)) continue;
      const scheduledAt = series.scheduledTime ? localDateTimeToUtc(d, series.scheduledTime, series.timezone) : null;
      let reminderAt = series.reminderTime ? localDateTimeToUtc(d, series.reminderTime, series.timezone) : null;
      // Do not create reminders that are already in the past at generation time.
      if (reminderAt && reminderAt <= nowIso) reminderAt = null;
      const task: Task = {
        attachments: [],
        id: newTaskId(),
        title: series.title,
        notes: series.notes,
        project: series.project,
        priority: series.priority,
        estimateMinutes: series.estimateMinutes,
        scheduledDate: scheduledAt ? null : d,
        scheduledAt,
        dueDate: null,
        dueAt: null,
        reminderAt,
        timezone: series.timezone,
        status: "todo",
        completedAt: null,
        seriesId: series.id,
        occurrenceDate: d,
        version: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.insertTask(task);
      this.queueEvent({ type: "task.created", id: task.id, related: { seriesId: series.id } });
      this.syncReminder(task);
      created.push(task);
    }
    this.db.prepare("UPDATE series SET generated_through = ? WHERE id = ?").run(to, series.id);
    return created;
  }

  // ---------------------------------------------------------------------
  // Reminders
  // ---------------------------------------------------------------------

  private pendingReminderFor(taskId: string): ReminderRow | undefined {
    return this.db
      .prepare("SELECT * FROM reminders WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as ReminderRow | undefined;
  }

  private cancelPendingReminders(taskId: string): void {
    const nowIso = this.nowIso();
    const res = this.db
      .prepare("UPDATE reminders SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status = 'pending'")
      .run(nowIso, taskId);
    if (res.changes > 0) this.queueEvent({ type: "reminder.updated", id: null, related: { taskId } });
  }

  /** Make the reminders table agree with task.reminderAt / task.status. */
  private syncReminder(task: Task): void {
    const pending = this.pendingReminderFor(task.id);
    if (task.status !== "todo" || !task.reminderAt) {
      if (pending) this.cancelPendingReminders(task.id);
      return;
    }
    if (pending && pending.fire_at === task.reminderAt) return;
    if (pending) this.cancelPendingReminders(task.id);
    const nowIso = this.nowIso();
    const id = newReminderId();
    this.db
      .prepare(
        `INSERT INTO reminders (id, task_id, fire_at, status, attempts, last_error, submitted_at, channel, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(id, task.id, task.reminderAt, nowIso, nowIso);
    this.queueEvent({ type: "reminder.updated", id, related: { taskId: task.id } });
  }

  listReminders(rawQuery: ListRemindersQuery = {}): Reminder[] {
    const q = ListRemindersQuery.parse(rawQuery);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status !== undefined) {
      const statuses = Array.isArray(q.status) ? q.status : [q.status];
      where.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    if (q.taskId) {
      where.push("task_id = ?");
      params.push(q.taskId);
    }
    const sql = `SELECT * FROM reminders ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY fire_at ASC LIMIT ?`;
    params.push(q.limit ?? 200);
    return (this.db.prepare(sql).all(...params) as ReminderRow[]).map(reminderFromRow);
  }

  /** Pending reminders whose time has come (and whose retry backoff, if any, elapsed). */
  dueReminders(): Reminder[] {
    const nowIso = this.nowIso();
    const rows = this.db
      .prepare(
        `SELECT * FROM reminders WHERE status = 'pending' AND fire_at <= ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY fire_at ASC`,
      )
      .all(nowIso, nowIso) as ReminderRow[];
    return rows.map(reminderFromRow);
  }

  /** Independent of system notification authorization/retries, delivered once per persisted reminder. */
  emitReminderCue(ids: string[], late: boolean): void {
    this.tx(() => {
      const pending: { id: string; task_id: string; fire_at: string }[] = [];
      for (const id of ids) {
        const row = this.db.prepare(`SELECT r.id, r.task_id, r.fire_at FROM reminders r JOIN tasks t ON t.id = r.task_id
          WHERE r.id = ? AND r.cue_emitted_at IS NULL AND r.status = 'pending'
            AND t.status = 'todo' AND t.reminder_at = r.fire_at`).get(id) as { id: string; task_id: string; fire_at: string } | undefined;
        if (!row) continue;
        this.db.prepare("UPDATE reminders SET cue_emitted_at = ? WHERE id = ?").run(this.nowIso(), id);
        pending.push(row);
      }
      if (pending.length) this.queueEvent({ type: "reminder.fired", id: pending[0]!.id,
        related: { taskId: pending[0]!.task_id, count: String(pending.length), late: String(late), fireAt: pending[0]!.fire_at } });
    });
  }

  markReminderSubmitted(id: string, channel: string, status: "submitted" | "missed" = "submitted"): void {
    const nowIso = this.nowIso();
    const row = this.db.prepare("SELECT task_id FROM reminders WHERE id = ?").get(id) as { task_id: string } | undefined;
    this.db
      .prepare(
        "UPDATE reminders SET status = ?, channel = ?, submitted_at = ?, attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?",
      )
      .run(status, channel, nowIso, nowIso, id);
    this.emit("reminder.updated", id, row ? { taskId: row.task_id } : undefined);
  }

  markReminderFailed(id: string, error: string, opts: { retryInMs?: number; maxAttempts?: number } = {}): void {
    const nowIso = this.nowIso();
    const row = this.db.prepare("SELECT task_id, attempts FROM reminders WHERE id = ?").get(id) as
      | { task_id: string; attempts: number }
      | undefined;
    if (!row) return;
    const attempts = row.attempts + 1;
    const max = opts.maxAttempts ?? 3;
    if (attempts >= max || opts.retryInMs === undefined) {
      this.db
        .prepare("UPDATE reminders SET status = 'failed', attempts = ?, last_error = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?")
        .run(attempts, error, nowIso, id);
    } else {
      const next = toUtcIso(new Date(this.now().getTime() + opts.retryInMs));
      this.db
        .prepare("UPDATE reminders SET attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?")
        .run(attempts, error, next, nowIso, id);
    }
    this.emit("reminder.updated", id, { taskId: row.task_id });
  }

  /** Task rows for a set of reminders, used by the scheduler to build notification text. */
  tasksById(ids: string[]): Map<string, Task> {
    const map = new Map<string, Task>();
    if (ids.length === 0) return map;
    const rows = this.db.prepare(`SELECT * FROM tasks WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as TaskRow[];
    for (const r of rows) map.set(r.id, this.hydrateTask(r));
    return map;
  }

  // ---------------------------------------------------------------------
  // Idempotency
  // ---------------------------------------------------------------------

  idempotencyGet(key: string): { requestHash: string; statusCode: number; body: string } | null {
    const row = this.db.prepare("SELECT request_hash, status_code, response_body FROM idempotency WHERE key = ?").get(key) as
      | { request_hash: string; status_code: number; response_body: string }
      | undefined;
    return row ? { requestHash: row.request_hash, statusCode: row.status_code, body: row.response_body } : null;
  }

  idempotencyPut(key: string, requestHash: string, statusCode: number, body: string): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO idempotency(key, request_hash, status_code, response_body, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(key, requestHash, statusCode, body, this.nowIso());
  }

  pruneIdempotency(maxAgeMs = 24 * 3600_000): number {
    const cutoff = toUtcIso(new Date(this.now().getTime() - maxAgeMs));
    return this.db.prepare("DELETE FROM idempotency WHERE created_at < ?").run(cutoff).changes;
  }

  // ---------------------------------------------------------------------
  // Ops
  // ---------------------------------------------------------------------

  counts(): { tasks: number; todo: number; series: number; pendingReminders: number; failedReminders: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      tasks: one("SELECT COUNT(*) n FROM tasks"),
      todo: one("SELECT COUNT(*) n FROM tasks WHERE status = 'todo'"),
      series: one("SELECT COUNT(*) n FROM series"),
      pendingReminders: one("SELECT COUNT(*) n FROM reminders WHERE status = 'pending'"),
      failedReminders: one("SELECT COUNT(*) n FROM reminders WHERE status = 'failed'"),
    };
  }

  exportBundle(): ExportBundle {
    const tasks = (this.db.prepare("SELECT * FROM tasks ORDER BY created_at").all() as TaskRow[]).map(this.hydrateTask);
    const series = (this.db.prepare("SELECT * FROM series ORDER BY created_at").all() as SeriesRow[]).map(seriesFromRow);
    const reminders = (this.db.prepare("SELECT * FROM reminders ORDER BY created_at").all() as ReminderRow[]).map(reminderFromRow);
    return { format: "todocue-export", version: 1, exportedAt: this.nowIso(), timezone: this.timezone, tasks, series, reminders, attachments: this.attachments.export() };
  }

  projects(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT project FROM tasks WHERE project IS NOT NULL AND project <> '' ORDER BY project")
      .all() as { project: string }[];
    return rows.map((r) => r.project);
  }
}

function emptyToNull(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function humanDate(date: string, today: string): string {
  if (date === today) return "今天";
  if (date === addDays(today, -1)) return "昨天";
  if (date === addDays(today, 1)) return "明天";
  const [, m, d] = date.split("-");
  return `${Number(m)}月${Number(d)}日`;
}
