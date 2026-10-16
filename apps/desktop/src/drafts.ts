import {
  CreateTaskInput,
  UpdateTaskInput,
  type Task,
  type AttachmentUpload,
  type Priority,
} from "@todocue/shared";
export interface TaskDraft {
  key: string;
  sessionId: string;
  original?: Task;
  title: string;
  notes: string;
  project: string;
  priority: Priority;
  estimate: string;
  scheduledMode: "none" | "date" | "time";
  scheduledDate: string;
  scheduledTime: string;
  dueMode: "none" | "date" | "time";
  dueDate: string;
  dueTime: string;
  reminder: string;
  timezone: string;
  repeat: "none" | "daily" | "weekly";
  weekdays: number[];
  start: string;
  end: string;
  /** Repeating tasks: a fixed time of day for every instance (off = date-level). */
  repeatTimeOn: boolean;
  repeatTime: string;
  /** Repeating tasks: remind at this time of day on every instance. */
  repeatReminderOn: boolean;
  repeatReminderTime: string;
  uploads: AttachmentUpload[];
  removed: string[];
}
/** Retain edits made while a save was in flight, rebased onto the saved version. */
export function afterSave(
  latest: TaskDraft,
  submitted: TaskDraft,
  saved: Task,
): TaskDraft | undefined {
  if (
    latest.original?.id === saved.id &&
    latest.original.version > saved.version
  )
    return latest;
  if (latest.key === submitted.key) return undefined;
  // The API appends uploads in submission order. Exclude original IDs first:
  // names and even bytes may be identical, so neither is an upload identity.
  const originalIds = new Set(submitted.original?.attachments.map((file) => file.id));
  const added = saved.attachments.filter((file) => !originalIds.has(file.id));
  const removedUploads = submitted.uploads.flatMap((upload, index) =>
    !latest.uploads.includes(upload) && added[index] ? [added[index]!.id] : [],
  );
  return {
    ...latest,
    original: saved,
    key: crypto.randomUUID(),
    uploads: latest.uploads.filter(
      (upload) => !submitted.uploads.includes(upload),
    ),
    removed: [...latest.removed.filter((id) => !submitted.removed.includes(id)), ...removedUploads],
  };
}
/** ISO weekday, Monday = 1 … Sunday = 7. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return Number.isNaN(day) ? 1 : day || 7;
}
/** "09:00" -> "09:00:00": inputs without a seconds step hand back HH:mm. */
const withSeconds = (value: string) => (/^\d{2}:\d{2}$/.test(value) ? `${value}:00` : value);
const dateTimeWithSeconds = (value: string) => (/T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value);

/** Why a draft cannot be saved yet, or null. The same checks and wording as the native form. */
export function validateDraft(draft: TaskDraft, language: string): string | null {
  const en = language === "en";
  if (!draft.title.trim()) return en ? "Enter a title" : "请输入标题";
  if (draft.estimate !== "" && (!Number.isInteger(Number(draft.estimate)) || Number(draft.estimate) < 0))
    return en ? "Estimate must be a whole number of minutes" : "预计耗时需要是非负整数分钟";
  if (!draft.original && draft.repeat === "weekly" && draft.weekdays.length === 0)
    return en ? "Pick at least one day for a weekly repeat" : "每周重复至少选择一天";
  return null;
}
/** Switching a repeat on starts it from the planned day, as the native form does. */
export function startRepeat(draft: TaskDraft): Partial<TaskDraft> {
  return draft.scheduledMode !== "none" ? { start: draft.scheduledDate } : {};
}

function local(instant: string | null, timezone: string) {
  if (!instant) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const p = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${p("year")}-${p("month")}-${p("day")}T${p("hour")}:${p("minute")}:${p("second")}`;
}
export function newDraft(
  task?: Task,
  date = new Date().toISOString().slice(0, 10),
  title = "",
  planned = true,
): TaskDraft {
  const timezone =
    task?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const schedule = local(task?.scheduledAt ?? null, timezone),
    due = local(task?.dueAt ?? null, timezone);
  return {
    key: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    original: task,
    title: task?.title ?? title,
    notes: task?.notes ?? "",
    project: task?.project ?? "",
    priority: task?.priority ?? "none",
    estimate: task?.estimateMinutes?.toString() ?? "",
    scheduledMode: task
      ? task.scheduledAt
        ? "time"
        : task.scheduledDate
          ? "date"
          : "none"
      : planned ? "date" : "none",
    scheduledDate: task?.scheduledDate ?? (schedule.slice(0, 10) || date),
    scheduledTime: schedule.slice(11) || "09:00:00",
    dueMode: task?.dueAt ? "time" : task?.dueDate ? "date" : "none",
    dueDate: task?.dueDate ?? (due.slice(0, 10) || date),
    dueTime: due.slice(11) || "18:00:00",
    reminder: local(task?.reminderAt ?? null, timezone),
    timezone,
    repeat: "none",
    weekdays: [isoWeekday(date)],
    start: date,
    end: "",
    repeatTimeOn: false,
    repeatTime: "09:00",
    repeatReminderOn: false,
    repeatReminderTime: "08:50",
    uploads: [],
    removed: [],
  };
}

/** Expanding typed quick input starts a separate task; empty input can continue a draft. */
export function composerDraft(saved: TaskDraft | undefined, date: string, title?: string, fromQuickAdd = false, calendar = false): TaskDraft {
  if (fromQuickAdd && title?.trim()) return newDraft(undefined, date, title);
  const draft = saved ?? newDraft(undefined, date, "", false);
  if (fromQuickAdd && calendar) return { ...draft, scheduledMode: "date", scheduledDate: date, key: crypto.randomUUID() };
  return draft;
}
export function draftPayload(
  draft: TaskDraft,
): CreateTaskInput | UpdateTaskInput {
  const common = {
    title: draft.title.trim(),
    notes: draft.notes || null,
    project: draft.project.trim() || null,
    priority: draft.priority,
    estimateMinutes: draft.estimate === "" ? null : Number(draft.estimate),
    timezone: draft.timezone,
  };
  const times = {
    scheduledDate: draft.scheduledMode === "date" ? draft.scheduledDate : null,
    scheduledAt:
      draft.scheduledMode === "time"
        ? `${draft.scheduledDate}T${withSeconds(draft.scheduledTime)}`
        : null,
    dueDate: draft.dueMode === "date" ? draft.dueDate : null,
    dueAt:
      draft.dueMode === "time" ? `${draft.dueDate}T${withSeconds(draft.dueTime)}` : null,
    reminderAt: draft.reminder ? dateTimeWithSeconds(draft.reminder) : null,
  };
  if (draft.original) {
    const baseline = newDraft(draft.original);
    if (draft.timezone === baseline.timezone) {
      if (
        draft.scheduledMode === baseline.scheduledMode &&
        draft.scheduledDate === baseline.scheduledDate &&
        draft.scheduledTime === baseline.scheduledTime
      ) {
        times.scheduledDate = draft.original.scheduledDate;
        times.scheduledAt = draft.original.scheduledAt;
      }
      if (
        draft.dueMode === baseline.dueMode &&
        draft.dueDate === baseline.dueDate &&
        draft.dueTime === baseline.dueTime
      ) {
        times.dueDate = draft.original.dueDate;
        times.dueAt = draft.original.dueAt;
      }
      if (draft.reminder === baseline.reminder)
        times.reminderAt = draft.original.reminderAt;
    }
    return UpdateTaskInput.parse({
      ...common,
      ...times,
      expectedVersion: draft.original.version,
      addAttachments: draft.uploads.length ? draft.uploads : undefined,
      removeAttachmentIds: draft.removed.length ? draft.removed : undefined,
    });
  }
  if (draft.repeat !== "none")
    return CreateTaskInput.parse({
      ...common,
      attachments: draft.uploads.length ? draft.uploads : undefined,
      repeat:
        draft.repeat === "daily"
          ? { kind: "daily" }
          : { kind: "weekly", weekdays: [...draft.weekdays].sort((a, b) => a - b) },
      startDate: draft.start,
      endDate: draft.end || null,
      scheduledTime: draft.repeatTimeOn ? draft.repeatTime.slice(0, 5) : undefined,
      reminderTime: draft.repeatReminderOn ? draft.repeatReminderTime.slice(0, 5) : undefined,
    });
  return CreateTaskInput.parse({
    ...common,
    ...times,
    attachments: draft.uploads.length ? draft.uploads : undefined,
  });
}
