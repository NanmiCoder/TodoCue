import type { Task, UpdateTaskInput, Series } from "@todocue/shared";
import { DateTime, Info } from "luxon";

// Match CalendarRange: Chinese starts Monday; English follows the user's region.
// Keep ISO weekdays (Monday = 1) separate from JavaScript's Sunday = 0.
export function calendarFirstWeekday(language: string, region: string): number {
  return language === "en" ? Info.getStartOfWeek({ locale: region }) : 1;
}
export function calendarDays(span: "month" | "week", anchor: string, firstDay: number): string[] {
  const start = span === "month" ? `${anchor.slice(0, 7)}-01` : anchor;
  const weekday = new Date(`${start}T12:00:00Z`).getUTCDay() || 7;
  const offset = (weekday - firstDay + 7) % 7;
  const length = span === "week" ? 7 : Math.ceil((offset + DateTime.fromISO(start).daysInMonth!) / 7) * 7;
  return Array.from({ length }, (_, index) => shiftDate(start, index - offset));
}
export function weekdayLabels(language: string, firstDay = 1, full = false): string[] {
  const labels = language === "en"
    ? (full ? ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] : ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"])
    : (full ? ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"] : ["一", "二", "三", "四", "五", "六", "日"]);
  return Array.from({ length: 7 }, (_, index) => labels[(index + firstDay - 1) % 7]!);
}
export function calendarTitle(span: "month" | "week", anchor: string, language: string, firstDay: number, today: string): string {
  const date = (day: string) => new Date(`${day}T12:00:00Z`);
  if (span === "month") return new Intl.DateTimeFormat(language, { year: "numeric", month: "short", timeZone: "UTC" }).format(date(anchor));
  const days = calendarDays("week", anchor, firstDay);
  const year = days.every(day => day.slice(0, 4) === today.slice(0, 4)) ? undefined : "numeric";
  const formatter = new Intl.DateTimeFormat(language, { year, month: "short", day: "numeric", timeZone: "UTC" });
  return `${formatter.format(date(days[0]!))} – ${formatter.format(date(days[6]!))}`;
}
export function dateOf(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
export function planDate(task: Task): string | null {
  return (
    task.scheduledDate ??
    (task.scheduledAt ? dateOf(task.scheduledAt, task.timezone) : null) ??
    task.dueDate ??
    (task.dueAt ? dateOf(task.dueAt, task.timezone) : null)
  );
}
export function calendarBucket(tasks: Task[], day: string) {
  const planned = tasks.filter(task => task.status === "todo" && planDate(task) === day);
  const history = tasks.filter(task => task.status !== "todo" && planDate(task) === day);
  const deadlines = tasks.filter(task => task.status === "todo" && planDate(task) !== day &&
    (task.dueDate ?? (task.dueAt ? dateOf(task.dueAt, task.timezone) : null)) === day);
  return { planned, history, deadlines };
}
export function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function stepCalendar(state: { span: "month" | "week"; anchor: string; selected: string }, steps: number, firstDay: number) {
  if (state.span === "week") {
    const anchor = shiftDate(state.anchor, steps * 7);
    const weekday = new Date(`${state.selected}T12:00:00Z`).getUTCDay();
    const selected = calendarDays("week", anchor, firstDay).find(day => new Date(`${day}T12:00:00Z`).getUTCDay() === weekday)!;
    return { anchor, selected };
  }
  const month = new Date(`${state.anchor.slice(0, 7)}-01T12:00:00Z`);
  month.setUTCMonth(month.getUTCMonth() + steps);
  const last = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
  month.setUTCDate(Math.min(Number(state.anchor.slice(-2)), last));
  const anchor = month.toISOString().slice(0, 10);
  return { anchor, selected: anchor };
}
export function taskOverdue(task: Task, today: string, now = Date.now()): boolean {
  return task.status === "todo" && (task.dueAt
    ? Date.parse(task.dueAt) < now
    : !!task.dueDate && task.dueDate < today);
}
/** Local calendar date of the machine, "YYYY-MM-DD". */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Relative wording near today, otherwise "MMM d EEE" (zh: 10月19日周一, en: Mon, Oct 19), with the
 * year whenever it is not the current one — the same rule as the native client's `TCDate.dateLabel`.
 */
export function dayLabel(date: string, language: string, today: string = localToday()) {
  const en = language === "en";
  if (!date) return en ? "Unscheduled" : "未安排";
  if (date === today) return en ? "Today" : "今天";
  if (DATE_PATTERN.test(today)) {
    if (date === shiftDate(today, 1)) return en ? "Tomorrow" : "明天";
    if (date === shiftDate(today, -1)) return en ? "Yesterday" : "昨天";
  }
  const value = new Date(`${date}T12:00:00Z`);
  if (!DATE_PATTERN.test(date) || Number.isNaN(value.getTime())) return date;
  return new Intl.DateTimeFormat(language, {
    year: date.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric",
    month: "short",
    day: "numeric",
    weekday: "short",
    timeZone: "UTC",
  }).format(value);
}
/** Hour cycle follows the system region, not the UI language: zh/en choose words, the OS chooses 12/24h. */
export function systemHour12(region: string | undefined = globalThis.navigator?.language): boolean {
  try {
    return new Intl.DateTimeFormat(region, { hour: "numeric" }).resolvedOptions().hour12 === true;
  } catch {
    return false;
  }
}
export function clockTime(instant: string, timezone: string, language: string, hour12 = systemHour12()): string {
  return new Intl.DateTimeFormat(language, {
    timeZone: timezone,
    hour: hour12 ? "numeric" : "2-digit",
    minute: "2-digit",
    hour12,
  }).format(new Date(instant));
}
/**
 * Label for an instant: today shows only the time, tomorrow "明天 HH:mm", anything else the
 * month and day (and year when not this one) before the time.
 */
export function instantLabel(instant: string, timezone: string, language: string, today: string = localToday(), hour12?: boolean): string {
  const en = language === "en";
  const time = clockTime(instant, timezone, language, hour12);
  const day = dateOf(instant, timezone);
  if (day === today) return time;
  if (DATE_PATTERN.test(today) && day === shiftDate(today, 1)) return `${en ? "Tomorrow" : "明天"} ${time}`;
  const label = new Intl.DateTimeFormat(language, {
    year: day.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
  return `${label} ${time}`;
}
/** "每日" / "每周 一、三" — weekly rules name their weekdays. */
export function ruleLabel(rule: Series["rule"], language: string): string {
  const en = language === "en";
  if (rule.kind === "daily") return en ? "Daily" : "每日";
  const names = en ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] : weekdayLabels(language, 1, false);
  const days = [...rule.weekdays].sort((a, b) => a - b).map((day) => names[day - 1]).filter(Boolean);
  return `${en ? "Weekly" : "每周"} ${days.join(en ? ", " : "、")}`;
}
export function reschedule(task: Task, date: string): UpdateTaskInput {
  if (!task.scheduledAt)
    return {
      expectedVersion: task.version,
      scheduledDate: date,
      scheduledAt: null,
    };
  const time = DateTime.fromISO(task.scheduledAt).setZone(task.timezone).toFormat("HH:mm:ss.SSS");
  // Resolve once, in the task's zone; confirmation and the write use this same instant.
  const instant = DateTime.fromISO(`${date}T${time}`, { zone: task.timezone }).toUTC().toISO();
  if (!instant) throw new Error("Invalid planned date");
  return {
    expectedVersion: task.version,
    scheduledAt: instant,
    scheduledDate: null,
    timezone: task.timezone,
  };
}
export function landsAfterDeadline(task: Task, date: string): boolean {
  const day = task.dueDate ?? (task.dueAt ? dateOf(task.dueAt, task.timezone) : null);
  if (!day) return false;
  if (date > day) return true;
  const moved = reschedule(task, date).scheduledAt;
  return !!(moved && task.dueAt && Date.parse(moved) > Date.parse(task.dueAt));
}
export function ghostDates(
  series: Series,
  from: string,
  to: string,
  existing: Set<string>,
): string[] {
  if (series.status !== "active" || !series.generatedThrough) return [];
  const output: string[] = [];
  let day = from > series.startDate ? from : series.startDate;
  if (day <= series.generatedThrough)
    day = shiftDate(series.generatedThrough, 1);
  for (
    let safety = 0;
    day <= to && (!series.endDate || day <= series.endDate) && safety < 3660;
    safety++, day = shiftDate(day, 1)
  ) {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay() || 7;
    if (
      (series.rule.kind === "daily" ||
        series.rule.weekdays.includes(weekday)) &&
      !existing.has(`${series.id}:${day}`)
    )
      output.push(day);
  }
  return output;
}
