import type { CreatePeriodicReminderInput, PeriodicReminder } from "@todocue/shared";
import { dateOf } from "./dates.js";

export type PeriodicField = "title" | "interval" | "weekdays" | "windows" | "timezone";
export type PeriodicErrors = Partial<Record<PeriodicField, string>>;

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
function minute(value: string, end = false): number | null {
  if (end && value === "24:00") return 1440;
  if (!CLOCK.test(value)) return null;
  const [h, m] = value.split(":").map(Number);
  return h! * 60 + m!;
}

function validTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Field-level checks, the same rules (and wording) as the native form and the runtime schema. */
export function validatePeriodic(config: CreatePeriodicReminderInput, language: string): PeriodicErrors {
  const en = language === "en";
  const text = (zh: string, english: string) => (en ? english : zh);
  const errors: PeriodicErrors = {};
  const title = config.title.trim();
  if (!title) errors.title = text("请输入标题", "Enter a title");
  else if (title.length > 500) errors.title = text("标题最多 500 个字符", "At most 500 characters");
  const interval = config.intervalMinutes;
  if (!Number.isInteger(interval) || interval < 1 || interval > 1440)
    errors.interval = text("间隔需要为 1–1440 分钟", "Interval must be 1–1440 minutes");
  if (!config.weekdays?.length) errors.weekdays = text("至少选择一天", "Select at least one day");
  const windows = config.windows ?? [];
  const ranges: [number, number][] = [];
  for (const window of windows) {
    const start = minute(window.start);
    const end = minute(window.end, true);
    if (start === null || end === null || end <= start) {
      errors.windows = text("请输入有效的起止时间，不支持跨午夜时段", "Enter a valid start and end; overnight windows are not supported");
      continue;
    }
    ranges.push([start, end]);
  }
  if (windows.length === 0) errors.windows = text("至少添加一个时段", "Add at least one window");
  ranges.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < ranges.length; index++)
    if (ranges[index]![0] < ranges[index - 1]![1]) errors.windows = text("生效时段不能重叠", "Windows must not overlap");
  if (!errors.windows && !errors.interval && !ranges.some(([start, end]) => end - start > interval))
    errors.interval = text("至少一个时段需要长于提醒间隔", "A window must be longer than the interval");
  if (config.timezone && !validTimezone(config.timezone)) errors.timezone = text("请输入有效的 IANA 时区", "Enter a valid IANA timezone");
  return errors;
}

/** The quick presets under the weekday picker. */
export const WEEKDAY_PRESETS = {
  everyday: [1, 2, 3, 4, 5, 6, 7],
  workdays: [1, 2, 3, 4, 5],
  weekend: [6, 7],
} as const;

/** A new window starts where the last ended and runs three hours; after 24:00 it restarts the morning. */
export function nextWindow(windows: { start: string; end: string }[]): { start: string; end: string } {
  const start = windows.at(-1)?.end ?? "09:00";
  if (start === "24:00") return { start: "09:00", end: "12:00" };
  const parsed = minute(start);
  const end = Math.min(1440, (parsed ?? 540) + 180);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { start, end: `${pad(Math.floor(end / 60))}:${pad(end % 60)}` };
}

/** "下一次：今天 14:30" / "下一次：10-19 14:30" in the rule's own timezone. */
export function nextFireLabel(nextFireAt: string | null | undefined, timezone: string, language: string, now = new Date()): string {
  const en = language === "en";
  if (!nextFireAt) return en ? "No upcoming reminder" : "暂无下一次提醒";
  const when = new Date(nextFireAt);
  if (Number.isNaN(when.getTime())) return en ? "No upcoming reminder" : "暂无下一次提醒";
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(when);
  const day = dateOf(nextFireAt, timezone);
  if (day === dateOf(now.toISOString(), timezone)) return en ? `Next: today ${clock}` : `下一次：今天 ${clock}`;
  const monthDay = day.slice(5);
  return en ? `Next: ${monthDay} ${clock}` : `下一次：${monthDay} ${clock}`;
}

/** What the state pill on a rule row says. */
export function periodicStateLabel(rule: Pick<PeriodicReminder, "state" | "nextFireAt" | "timezone">, language: string, now = new Date()): string {
  const en = language === "en";
  if (rule.state === "waiting") return en ? "Waiting" : "等待确认";
  if (rule.state === "paused_today") return en ? "Paused today" : "今天暂停";
  if (rule.state === "paused") return en ? "Paused" : "已暂停";
  return nextFireLabel(rule.nextFireAt, rule.timezone, language, now);
}
