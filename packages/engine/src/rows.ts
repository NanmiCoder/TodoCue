import type { Priority, Reminder, RecurrenceRule, Series, Task } from "@todocue/shared";

export interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  project: string | null;
  priority: Priority;
  estimate_minutes: number | null;
  scheduled_date: string | null;
  scheduled_at: string | null;
  due_date: string | null;
  due_at: string | null;
  reminder_at: string | null;
  timezone: string;
  status: Task["status"];
  completed_at: string | null;
  series_id: string | null;
  occurrence_date: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface SeriesRow {
  id: string;
  title: string;
  notes: string | null;
  project: string | null;
  priority: Priority;
  estimate_minutes: number | null;
  rule_kind: "daily" | "weekly";
  weekdays: string | null;
  scheduled_time: string | null;
  reminder_time: string | null;
  timezone: string;
  start_date: string;
  end_date: string | null;
  status: Series["status"];
  stopped_at: string | null;
  generated_through: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ReminderRow {
  id: string;
  task_id: string;
  fire_at: string;
  status: Reminder["status"];
  attempts: number;
  last_error: string | null;
  submitted_at: string | null;
  channel: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

export function taskFromRow(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    project: r.project,
    priority: r.priority,
    estimateMinutes: r.estimate_minutes,
    scheduledDate: r.scheduled_date,
    scheduledAt: r.scheduled_at,
    dueDate: r.due_date,
    dueAt: r.due_at,
    reminderAt: r.reminder_at,
    timezone: r.timezone,
    status: r.status,
    completedAt: r.completed_at,
    seriesId: r.series_id,
    occurrenceDate: r.occurrence_date,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function taskToRow(t: Task): TaskRow {
  return {
    id: t.id,
    title: t.title,
    notes: t.notes,
    project: t.project,
    priority: t.priority,
    estimate_minutes: t.estimateMinutes,
    scheduled_date: t.scheduledDate,
    scheduled_at: t.scheduledAt,
    due_date: t.dueDate,
    due_at: t.dueAt,
    reminder_at: t.reminderAt,
    timezone: t.timezone,
    status: t.status,
    completed_at: t.completedAt,
    series_id: t.seriesId,
    occurrence_date: t.occurrenceDate,
    version: t.version,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

export function seriesFromRow(r: SeriesRow): Series {
  const rule: RecurrenceRule =
    r.rule_kind === "daily"
      ? { kind: "daily" }
      : { kind: "weekly", weekdays: JSON.parse(r.weekdays ?? "[]") as number[] };
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    project: r.project,
    priority: r.priority,
    estimateMinutes: r.estimate_minutes,
    rule,
    scheduledTime: r.scheduled_time,
    reminderTime: r.reminder_time,
    timezone: r.timezone,
    startDate: r.start_date,
    endDate: r.end_date,
    status: r.status,
    stoppedAt: r.stopped_at,
    generatedThrough: r.generated_through,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function seriesToRow(s: Series): SeriesRow {
  return {
    id: s.id,
    title: s.title,
    notes: s.notes,
    project: s.project,
    priority: s.priority,
    estimate_minutes: s.estimateMinutes,
    rule_kind: s.rule.kind,
    weekdays: s.rule.kind === "weekly" ? JSON.stringify([...s.rule.weekdays].sort((a, b) => a - b)) : null,
    scheduled_time: s.scheduledTime,
    reminder_time: s.reminderTime,
    timezone: s.timezone,
    start_date: s.startDate,
    end_date: s.endDate,
    status: s.status,
    stopped_at: s.stoppedAt,
    generated_through: s.generatedThrough,
    version: s.version,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

export function reminderFromRow(r: ReminderRow): Reminder {
  return {
    id: r.id,
    taskId: r.task_id,
    fireAt: r.fire_at,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    submittedAt: r.submitted_at,
    channel: r.channel,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
