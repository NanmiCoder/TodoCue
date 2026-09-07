import { TodoCueError, type ContextInfo } from "@todocue/shared";
import { addDays } from "@todocue/engine";

const WEEKDAYS: Record<string, number> = {
  mon: 1, monday: 1, "周一": 1, tue: 2, tuesday: 2, "周二": 2, wed: 3, wednesday: 3, "周三": 3,
  thu: 4, thursday: 4, "周四": 4, fri: 5, friday: 5, "周五": 5, sat: 6, saturday: 6, "周六": 6, sun: 7, sunday: 7, "周日": 7, "周天": 7,
};

export function parseWeekdays(v: string): number[] {
  return v
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((w) => {
      const n = Number.parseInt(w, 10);
      if (Number.isInteger(n) && n >= 1 && n <= 7) return n;
      const d = WEEKDAYS[w.toLowerCase()];
      if (!d) throw TodoCueError.validation(`unknown weekday: ${w}`);
      return d;
    });
}

/** Resolve `today`, `tomorrow`, `+Nd`, or YYYY-MM-DD. */
export function resolveDate(v: string, ctx: ContextInfo): string {
  const s = v.trim().toLowerCase();
  if (s === "today" || s === "今天") return ctx.today;
  if (s === "tomorrow" || s === "明天") return addDays(ctx.today, 1);
  if (s === "yesterday" || s === "昨天") return addDays(ctx.today, -1);
  const rel = /^\+(\d+)d$/.exec(s);
  if (rel) return addDays(ctx.today, Number.parseInt(rel[1]!, 10));
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  throw TodoCueError.validation(`invalid date: ${v} (use YYYY-MM-DD, today, tomorrow, +Nd)`);
}

/**
 * Resolve an instant argument to a local ISO date-time (interpreted by the runtime
 * in its timezone) or pass through explicit ISO strings.
 * Forms: `HH:mm` (today), `tomorrow 09:00`, `YYYY-MM-DD HH:mm`, `+30m`, `+2h`, ISO.
 */
export function resolveInstant(v: string, ctx: ContextInfo): string {
  const s = v.trim();
  const rel = /^\+(\d+)\s*(m|min|h|d)$/i.exec(s);
  if (rel) {
    const n = Number.parseInt(rel[1]!, 10);
    const unit = rel[2]!.toLowerCase();
    const ms = unit.startsWith("m") ? n * 60_000 : unit === "h" ? n * 3600_000 : n * 86_400_000;
    return new Date(new Date(ctx.now).getTime() + ms).toISOString();
  }
  const timeOnly = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (timeOnly) return `${ctx.today}T${timeOnly[1]!.padStart(2, "0")}:${timeOnly[2]}:00`;
  const dayTime = /^(\S+)\s+([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (dayTime) {
    const date = resolveDate(dayTime[1]!, ctx);
    return `${date}T${dayTime[2]!.padStart(2, "0")}:${dayTime[3]}:00`;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
  throw TodoCueError.validation(`invalid time: ${v} (use HH:mm, "tomorrow 09:00", "YYYY-MM-DD HH:mm", +30m, or ISO)`);
}
