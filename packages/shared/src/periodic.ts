import { z } from "zod";
import { IanaTimezone, InstantUtc, TimeString, Weekday } from "./schemas.js";

export const PeriodicMode = z.enum(["fixed", "after_completion"]);
export const PeriodicWindow = z.object({
  start: TimeString,
  end: z.union([TimeString, z.literal("24:00")]),
}).strict();
export type PeriodicWindow = z.infer<typeof PeriodicWindow>;
export const PERIODIC_DEFAULTS = {
  intervalMinutes: 30,
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  windows: [{ start: "09:00", end: "18:00" }],
  mode: "after_completion" as const,
  followUpMinutes: 10,
  enabled: true,
};
/** After this many unanswered follow-ups a habit reminder stops re-asking and just stays pending. */
export const PERIODIC_MAX_FOLLOW_UPS = 3;
/** The shortest absence that counts as having stood up (see PeriodicAwayInput). */
export const PERIODIC_MIN_AWAY_MINUTES = 3;

export function minuteOfDay(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour! * 60 + minute!;
}

const fields = {
  title: z.string().trim().min(1).max(500),
  intervalMinutes: z.number().int().min(1).max(1440),
  weekdays: z.array(Weekday).min(1).max(7),
  windows: z.array(PeriodicWindow).min(1).max(24),
  mode: PeriodicMode,
  /** after_completion only: re-ask this many minutes after an unanswered cue; 0 turns it off. */
  followUpMinutes: z.number().int().min(0).max(120),
  timezone: IanaTimezone,
  enabled: z.boolean(),
};

export const PeriodicConfig = z.object(fields).strict().superRefine((value, ctx) => {
  if (new Set(value.weekdays).size !== value.weekdays.length) {
    ctx.addIssue({ code: "custom", path: ["weekdays"], message: "生效星期不能重复" });
  }
  const windows = [...value.windows].sort((a, b) => minuteOfDay(a.start) - minuteOfDay(b.start));
  windows.forEach((window, index) => {
    if (minuteOfDay(window.start) >= minuteOfDay(window.end)) {
      ctx.addIssue({ code: "custom", path: ["windows"], message: "结束时间必须晚于开始时间，不支持跨午夜时段" });
    }
    if (index > 0 && minuteOfDay(window.start) < minuteOfDay(windows[index - 1]!.end)) {
      ctx.addIssue({ code: "custom", path: ["windows"], message: "生效时段不能重叠" });
    }
  });
  if (!windows.some((w) => minuteOfDay(w.end) - minuteOfDay(w.start) > value.intervalMinutes)) {
    ctx.addIssue({ code: "custom", path: ["intervalMinutes"], message: "至少一个时段需要长于提醒间隔" });
  }
});
export type PeriodicConfig = z.infer<typeof PeriodicConfig>;
export const CreatePeriodicReminderInput = z.object({
  ...fields,
  weekdays: fields.weekdays.optional(), windows: fields.windows.optional(), mode: fields.mode.optional(),
  followUpMinutes: fields.followUpMinutes.optional(), timezone: fields.timezone.optional(), enabled: fields.enabled.optional(),
}).strict();
export type CreatePeriodicReminderInput = z.infer<typeof CreatePeriodicReminderInput>;
export const UpdatePeriodicReminderInput = z.object(fields).partial().extend({ expectedVersion: z.number().int().optional() }).strict();
export type UpdatePeriodicReminderInput = z.infer<typeof UpdatePeriodicReminderInput>;
export function normalizePeriodicConfig(input: CreatePeriodicReminderInput, timezone: string): PeriodicConfig {
  const value = PeriodicConfig.parse({ ...PERIODIC_DEFAULTS, timezone, ...input });
  return { ...value, weekdays: [...value.weekdays].sort((a, b) => a - b),
    windows: [...value.windows].sort((a, b) => minuteOfDay(a.start) - minuteOfDay(b.start)) };
}

export const PeriodicOccurrence = z.object({
  id: z.string(), ruleId: z.string(), ruleVersion: z.number().int(), scheduledAt: InstantUtc,
  fireAt: InstantUtc, round: z.number().int(),
  delivery: z.enum(["scheduled", "offered", "claimed", "displayed", "submitted", "failed", "missed", "cancelled"]),
  result: z.enum(["pending", "completed", "expired", "cancelled"]),
  channel: z.string().nullable(), offeredAt: InstantUtc.nullable(), claimToken: z.string().nullable(),
  claimedAt: InstantUtc.nullable(), displayedAt: InstantUtc.nullable(), handledAt: InstantUtc.nullable(),
  lastError: z.string().nullable(), createdAt: InstantUtc, updatedAt: InstantUtc,
  /** Unanswered re-asks of this occurrence (round also counts snoozes). */
  followUps: z.number().int().nonnegative().default(0),
  /** Snoozes the user chose on this occurrence; unlike followUps it is never reset. */
  snoozes: z.number().int().nonnegative().default(0),
  /** Who closed a completed occurrence: the user, or an absence from the computer. */
  handledVia: z.enum(["user", "away"]).optional(),
});
export type PeriodicOccurrence = z.infer<typeof PeriodicOccurrence>;
export const PeriodicReminder = z.object({
  ...fields, followUpMinutes: fields.followUpMinutes.default(PERIODIC_DEFAULTS.followUpMinutes), id: z.string(), version: z.number().int(), revision: z.number().int().nonnegative().default(0), pausedOn: z.string().nullable(),
  stateDate: z.string(), nextFireAt: InstantUtc.nullable(), currentOccurrenceId: z.string().nullable(),
  createdAt: InstantUtc, updatedAt: InstantUtc,
  summary: z.string(), state: z.enum(["scheduled", "waiting", "paused_today", "paused"]),
  currentOccurrence: PeriodicOccurrence.nullable(),
});
export type PeriodicReminder = z.infer<typeof PeriodicReminder>;
export const PeriodicActionInput = z.object({
  action: z.enum(["pause", "resume", "pause_today", "complete", "snooze", "delete"]),
  expectedVersion: z.number().int().optional(), occurrenceId: z.string().optional(),
  round: z.number().int().optional(), minutes: z.number().int().min(1).max(1440).optional(),
}).strict();
export type PeriodicActionInput = z.infer<typeof PeriodicActionInput>;
/** "I was away from the computer for this long": counts as a break for habit (after_completion) rules. */
export const PeriodicAwayInput = z.object({ minutes: z.number().int().min(PERIODIC_MIN_AWAY_MINUTES).max(1440) }).strict();
export type PeriodicAwayInput = z.infer<typeof PeriodicAwayInput>;
export const PeriodicClaimInput = z.object({ occurrenceId: z.string(), round: z.number().int(), token: z.string().min(1).max(128) }).strict();
export const PeriodicReceiptInput = PeriodicClaimInput.extend({ displayed: z.boolean() });

export function periodicSummary(config: PeriodicConfig): string {
  const names = ["", "一", "二", "三", "四", "五", "六", "日"];
  const days = config.weekdays.length === 7 ? "每天" : `每周${config.weekdays.map((d) => names[d]).join("、")}`;
  return `${days} · ${config.windows.map((w) => `${w.start}–${w.end}`).join("、")} · 每 ${config.intervalMinutes} 分钟${config.mode === "after_completion"
    ? `（完成后重新计时${config.followUpMinutes > 0 ? `，没响应 ${config.followUpMinutes} 分钟后再提醒` : ""}）` : ""}`;
}
