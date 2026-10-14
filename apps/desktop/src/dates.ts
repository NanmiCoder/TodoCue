import type { Task, UpdateTaskInput, Series } from "@todocue/shared";
import { DateTime } from "luxon";
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
export function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
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
