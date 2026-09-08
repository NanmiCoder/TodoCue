import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitive formats
// ---------------------------------------------------------------------------

/** Calendar date, `YYYY-MM-DD`, interpreted in the task's timezone. */
export const DateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .describe("Calendar date YYYY-MM-DD");

/** Clock time `HH:mm` (24h). */
export const TimeString = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:mm")
  .describe("Clock time HH:mm");

/**
 * An instant. Accepts ISO-8601 with offset/`Z` (used as-is) or a local
 * ISO date-time without offset (interpreted in `timezone`).
 */
export const InstantInput = z
  .string()
  .min(10)
  .describe("ISO-8601 date-time; with offset/Z or local time interpreted in timezone");

/** Instant as stored/returned: ISO-8601 UTC (`...Z`). */
export const InstantUtc = z.string().describe("ISO-8601 UTC instant");

export const IanaTimezone = z.string().min(1).describe("IANA timezone, e.g. Asia/Shanghai");

/** Boolean that also accepts query-string forms: "true"/"false"/"1"/"0". */
export const QueryBoolean = z.preprocess((v) => {
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return v;
}, z.boolean());

export const Priority = z.enum(["none", "low", "medium", "high"]);
export type Priority = z.infer<typeof Priority>;
export const priorityRank: Record<Priority, number> = { none: 0, low: 1, medium: 2, high: 3 };

export const TaskStatus = z.enum(["todo", "done", "cancelled", "skipped"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const SeriesStatus = z.enum(["active", "stopped"]);
export type SeriesStatus = z.infer<typeof SeriesStatus>;

export const ReminderStatus = z.enum(["pending", "submitted", "failed", "missed", "cancelled"]);
export type ReminderStatus = z.infer<typeof ReminderStatus>;

export const Weekday = z.number().int().min(1).max(7).describe("ISO weekday: 1=Mon … 7=Sun");

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TASK_ATTACHMENT_BYTES = 30 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;
export const ATTACHMENT_BODY_LIMIT = 42 * 1024 * 1024;

export const Attachment = z.object({
  id: z.string(),
  taskId: z.string(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  createdAt: InstantUtc,
});
export type Attachment = z.infer<typeof Attachment>;

export const AttachmentUpload = z.object({
  name: z.string().trim().min(1).max(255).regex(/^[^\x00-\x1f\x7f/\\]+$/, "use a filename without path separators or control characters").refine((name) => name !== "." && name !== "..", "invalid filename"),
  mediaType: z.string().max(127).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/).optional(),
  dataBase64: z.string().max(4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3)).describe("Standard padded base64 file bytes; max 10 MiB per file"),
}).strict();
export type AttachmentUpload = z.infer<typeof AttachmentUpload>;
export const AddAttachmentsInput = z.object({
  files: z.array(AttachmentUpload).min(1).max(MAX_ATTACHMENTS),
  expectedVersion: z.number().int().optional(),
}).strict();
export type AddAttachmentsInput = z.infer<typeof AddAttachmentsInput>;

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  project: z.string().nullable(),
  priority: Priority,
  estimateMinutes: z.number().int().nullable(),
  /** Date-level plan; mutually exclusive with scheduledAt. */
  scheduledDate: DateString.nullable(),
  /** Instant-level plan (UTC); mutually exclusive with scheduledDate. */
  scheduledAt: InstantUtc.nullable(),
  dueDate: DateString.nullable(),
  dueAt: InstantUtc.nullable(),
  /** Explicit reminder instant (UTC). */
  reminderAt: InstantUtc.nullable(),
  timezone: IanaTimezone,
  status: TaskStatus,
  completedAt: InstantUtc.nullable(),
  seriesId: z.string().nullable(),
  /** Local occurrence date for series instances. */
  occurrenceDate: DateString.nullable(),
  version: z.number().int(),
  createdAt: InstantUtc,
  updatedAt: InstantUtc,
  attachments: z.array(Attachment).default([]),
});
export type Task = z.infer<typeof Task>;

export const RecurrenceRule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily") }),
  z.object({ kind: z.literal("weekly"), weekdays: z.array(Weekday).min(1).max(7) }),
]);
export type RecurrenceRule = z.infer<typeof RecurrenceRule>;

export const Series = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  project: z.string().nullable(),
  priority: Priority,
  estimateMinutes: z.number().int().nullable(),
  rule: RecurrenceRule,
  /** Local time of day for each instance's scheduledAt; null = date-level plan. */
  scheduledTime: TimeString.nullable(),
  /** Local time of day for each instance's reminder; null = no reminder. */
  reminderTime: TimeString.nullable(),
  timezone: IanaTimezone,
  startDate: DateString,
  endDate: DateString.nullable(),
  status: SeriesStatus,
  stoppedAt: InstantUtc.nullable(),
  /** Instances have been generated up to and including this local date. */
  generatedThrough: DateString.nullable(),
  version: z.number().int(),
  createdAt: InstantUtc,
  updatedAt: InstantUtc,
});
export type Series = z.infer<typeof Series>;

export const Reminder = z.object({
  id: z.string(),
  taskId: z.string(),
  fireAt: InstantUtc,
  status: ReminderStatus,
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  submittedAt: InstantUtc.nullable(),
  /** How it reached the system: helper notification, fallback, or summary of missed reminders. */
  channel: z.string().nullable(),
  createdAt: InstantUtc,
  updatedAt: InstantUtc,
});
export type Reminder = z.infer<typeof Reminder>;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const nullableText = z.string().max(4000).nullable().optional();

export const CreateTaskInput = z
  .object({
    title: z.string().trim().min(1).max(500),
    attachments: z.array(AttachmentUpload).max(MAX_ATTACHMENTS).optional(),
    notes: nullableText,
    project: z.string().trim().max(100).nullable().optional(),
    priority: Priority.optional(),
    estimateMinutes: z.number().int().min(0).max(24 * 60 * 30).nullable().optional(),
    scheduledDate: DateString.nullable().optional(),
    scheduledAt: InstantInput.nullable().optional(),
    dueDate: DateString.nullable().optional(),
    dueAt: InstantInput.nullable().optional(),
    reminderAt: InstantInput.nullable().optional(),
    /** Timezone used to interpret local inputs and date-level fields. Defaults to runtime timezone. */
    timezone: IanaTimezone.optional(),
    /** Optional recurrence; when present a series is created and the first instances generated. */
    repeat: RecurrenceRule.optional(),
    /** For repeating tasks: local time of day per instance (uses scheduledAt's local time when omitted). */
    scheduledTime: TimeString.optional(),
    reminderTime: TimeString.optional(),
    startDate: DateString.optional(),
    endDate: DateString.nullable().optional(),
  })
  .strict();
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

export const UpdateTaskInput = z
  .object({
    addAttachments: z.array(AttachmentUpload).max(MAX_ATTACHMENTS).optional(),
    removeAttachmentIds: z.array(z.string()).max(MAX_ATTACHMENTS).optional(),
    expectedVersion: z.number().int().optional(),
    title: z.string().trim().min(1).max(500).optional(),
    notes: nullableText,
    project: z.string().trim().max(100).nullable().optional(),
    priority: Priority.optional(),
    estimateMinutes: z.number().int().min(0).max(24 * 60 * 30).nullable().optional(),
    scheduledDate: DateString.nullable().optional(),
    scheduledAt: InstantInput.nullable().optional(),
    dueDate: DateString.nullable().optional(),
    dueAt: InstantInput.nullable().optional(),
    reminderAt: InstantInput.nullable().optional(),
    timezone: IanaTimezone.optional(),
  })
  .strict();
export type UpdateTaskInput = z.infer<typeof UpdateTaskInput>;

export const VersionedAction = z.object({ expectedVersion: z.number().int().optional() }).strict();
export type VersionedAction = z.infer<typeof VersionedAction>;

export const SnoozeInput = z
  .object({
    expectedVersion: z.number().int().optional(),
    minutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
    until: InstantInput.optional(),
  })
  .strict();
export type SnoozeInput = z.infer<typeof SnoozeInput>;

export const CreateSeriesInput = z
  .object({
    title: z.string().trim().min(1).max(500),
    notes: nullableText,
    project: z.string().trim().max(100).nullable().optional(),
    priority: Priority.optional(),
    estimateMinutes: z.number().int().min(0).nullable().optional(),
    rule: RecurrenceRule,
    scheduledTime: TimeString.nullable().optional(),
    reminderTime: TimeString.nullable().optional(),
    timezone: IanaTimezone.optional(),
    startDate: DateString.optional(),
    endDate: DateString.nullable().optional(),
  })
  .strict();
export type CreateSeriesInput = z.infer<typeof CreateSeriesInput>;

export const ListView = z.enum(["all", "today", "upcoming"]);
export type ListView = z.infer<typeof ListView>;
export const OrderedGroup = z.object({ view: ListView, group: z.string(), taskIds: z.array(z.string()) });
export type OrderedGroup = z.infer<typeof OrderedGroup>;
export const OrderingState = z.object({ revision: z.number().int(), groups: z.array(OrderedGroup) });
export type OrderingState = z.infer<typeof OrderingState>;
export const MoveTaskInput = z.object({
  view: ListView,
  sourceGroup: z.string().max(200),
  targetGroup: z.string().max(200),
  beforeId: z.string().nullable(),
  expectedVersion: z.number().int(),
  expectedRevision: z.number().int(),
  allowPastDeadline: z.boolean().optional(),
}).strict();
export type MoveTaskInput = z.infer<typeof MoveTaskInput>;
export const ResetOrderInput = z.object({
  view: ListView, group: z.string().max(200), expectedRevision: z.number().int(),
}).strict();
export type ResetOrderInput = z.infer<typeof ResetOrderInput>;
export const UndoOrderInput = z.object({ token: z.string(), expectedRevision: z.number().int() }).strict();
export type UndoOrderInput = z.infer<typeof UndoOrderInput>;

export const ListTasksQuery = z
  .object({
    view: ListView.optional(),
    status: z.union([TaskStatus, z.array(TaskStatus)]).optional(),
    project: z.string().optional(),
    seriesId: z.string().optional(),
    /** Free text search in title/notes. */
    q: z.string().optional(),
    /** Only tasks planned/due on or after this local date. */
    from: DateString.optional(),
    /** Only tasks planned/due on or before this local date. */
    to: DateString.optional(),
    /** Include tasks with no plan or due at all (default true). */
    includeUnscheduled: QueryBoolean.optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();
export type ListTasksQuery = z.infer<typeof ListTasksQuery>;

export const ListRemindersQuery = z
  .object({
    status: z.union([ReminderStatus, z.array(ReminderStatus)]).optional(),
    taskId: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();
export type ListRemindersQuery = z.infer<typeof ListRemindersQuery>;

// ---------------------------------------------------------------------------
// Query results
// ---------------------------------------------------------------------------

export const TodayReason = z.enum(["overdue", "due_today", "scheduled_today", "carried_over"]);
export type TodayReason = z.infer<typeof TodayReason>;

export const TodaySection = z.enum(["overdue", "must", "scheduled"]);
export type TodaySection = z.infer<typeof TodaySection>;

export const TodayItem = z.object({
  task: Task,
  reasons: z.array(TodayReason),
  section: TodaySection,
});
export type TodayItem = z.infer<typeof TodayItem>;

export const TodayResult = z.object({
  date: DateString,
  timezone: IanaTimezone,
  now: InstantUtc,
  remaining: z.number().int(),
  items: z.array(TodayItem),
  completed: z.array(Task),
});
export type TodayResult = z.infer<typeof TodayResult>;

export const NextGroup = z.enum(["overdue", "due_today", "scheduled_reached", "unscheduled"]);
export type NextGroup = z.infer<typeof NextGroup>;

export const NextCandidate = z.object({
  task: Task,
  group: NextGroup,
  reason: z.string(),
});
export type NextCandidate = z.infer<typeof NextCandidate>;

export const NextResult = z.object({
  now: InstantUtc,
  timezone: IanaTimezone,
  next: NextCandidate.nullable(),
  candidates: z.array(NextCandidate),
});
export type NextResult = z.infer<typeof NextResult>;

export const ContextInfo = z.object({
  now: InstantUtc,
  timezone: IanaTimezone,
  today: DateString,
  localNow: z.string().describe("Local ISO date-time without offset"),
  weekday: Weekday,
  runtimeVersion: z.string(),
});
export type ContextInfo = z.infer<typeof ContextInfo>;

// ---------------------------------------------------------------------------
// Events (SSE)
// ---------------------------------------------------------------------------

export const EventType = z.enum([
  "reminder.fired",
  "task.created",
  "task.updated",
  "series.created",
  "series.updated",
  "reminder.updated",
  "day.changed",
  "runtime.started",
]);
export type EventType = z.infer<typeof EventType>;

export const RuntimeEvent = z.object({
  seq: z.number().int(),
  type: EventType,
  at: InstantUtc,
  id: z.string().nullable(),
  /** Related ids, e.g. taskId for reminder events. */
  related: z.record(z.string(), z.string()).optional(),
});
export type RuntimeEvent = z.infer<typeof RuntimeEvent>;

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

export const NotificationAuthorization = z.enum(["authorized", "provisional", "denied", "notDetermined", "unknown"]);
export type NotificationAuthorization = z.infer<typeof NotificationAuthorization>;

export const DoctorCheck = z.object({
  name: z.string(),
  ok: z.boolean(),
  level: z.enum(["ok", "warn", "error"]),
  detail: z.string(),
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;

export const DoctorReport = z.object({
  runtimeVersion: z.string(),
  nodeVersion: z.string(),
  home: z.string(),
  databasePath: z.string(),
  schemaVersion: z.number().int(),
  timezone: IanaTimezone,
  baseUrl: z.string(),
  pid: z.number().int(),
  uptimeSeconds: z.number(),
  notifier: z.object({
    path: z.string().nullable(),
    available: z.boolean(),
    authorization: NotificationAuthorization,
    detail: z.string().nullable(),
  }),
  counts: z.object({
    tasks: z.number().int(),
    todo: z.number().int(),
    series: z.number().int(),
    pendingReminders: z.number().int(),
    failedReminders: z.number().int(),
  }),
  checks: z.array(DoctorCheck),
});
export type DoctorReport = z.infer<typeof DoctorReport>;

export const ExportBundle = z.object({
  format: z.literal("todocue-export"),
  version: z.literal(1),
  exportedAt: InstantUtc,
  timezone: IanaTimezone,
  tasks: z.array(Task),
  series: z.array(Series),
  reminders: z.array(Reminder),
  attachments: z.array(Attachment.extend({ dataBase64: z.string() })).default([]),
  ordering: OrderingState.optional(),
});
export type ExportBundle = z.infer<typeof ExportBundle>;

/** Connection descriptor written by the runtime for local clients. */
export const ConnectionInfo = z.object({
  baseUrl: z.string(),
  token: z.string(),
  pid: z.number().int(),
  startedAt: InstantUtc,
  runtimeVersion: z.string(),
});
export type ConnectionInfo = z.infer<typeof ConnectionInfo>;
