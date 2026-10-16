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
export function dayLabel(date: string, language: string, today?: string) {
  if (!date) return language === "en" ? "Unscheduled" : "未安排";
  if (date === today) return language === "en" ? "Today" : "今天";
  return new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00`));
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
/**
 * "Move to tomorrow" from a task's menu, ported from the native client's
 * `TaskRescheduling.tomorrow`. Unlike `reschedule` (the calendar's drag semantics, which leave
 * the deadline alone), this also moves a deadline that falls before tomorrow, so an overdue or
 * due-today task actually leaves Today. Future deadlines are kept. Times of day are preserved
 * and resolved once, in the task's own zone.
 */
export function rescheduleToTomorrow(task: Task, today: string): UpdateTaskInput {
  const tomorrow = shiftDate(today, 1);
  const zone = task.timezone;
  const moved = (value: string): string => {
    const time = DateTime.fromISO(value).setZone(zone).toFormat("HH:mm:ss.SSS");
    const instant = DateTime.fromISO(`${tomorrow}T${time}`, { zone }).toUTC().toISO();
    if (!instant) throw new Error("Invalid planned date");
    return instant;
  };
  const patch: UpdateTaskInput = { expectedVersion: task.version };
  if (task.scheduledAt) {
    patch.scheduledAt = moved(task.scheduledAt);
    patch.scheduledDate = null;
    patch.timezone = zone;
  } else {
    patch.scheduledDate = tomorrow;
    patch.scheduledAt = null;
  }
  const tomorrowStart = DateTime.fromISO(tomorrow, { zone }).toMillis();
  if (task.dueAt) {
    if (Date.parse(task.dueAt) < tomorrowStart) {
      patch.dueAt = moved(task.dueAt);
      patch.dueDate = null;
      patch.timezone = zone;
    }
  } else if (task.dueDate && task.dueDate < tomorrow) {
    patch.dueDate = tomorrow;
    patch.dueAt = null;
  }
  return patch;
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
