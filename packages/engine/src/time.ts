import { DateTime, type DateTimeOptions } from "luxon";
import { TodoCueError } from "@todocue/shared";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A controllable clock for tests and simulations. */
export class FakeClock implements Clock {
  private current: Date;
  constructor(start: Date | string) {
    this.current = typeof start === "string" ? new Date(start) : new Date(start.getTime());
  }
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(to: Date | string): void {
    this.current = typeof to === "string" ? new Date(to) : new Date(to.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export function systemTimezone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimezone(tz) ? tz : "UTC";
}

export function isValidTimezone(tz: string | undefined | null): tz is string {
  if (!tz) return false;
  return DateTime.now().setZone(tz).isValid;
}

export function assertTimezone(tz: string): string {
  if (!isValidTimezone(tz)) throw TodoCueError.validation(`invalid timezone: ${tz}`, { timezone: tz });
  return tz;
}

export function toUtcIso(d: Date | DateTime): string {
  const dt = d instanceof Date ? DateTime.fromJSDate(d) : d;
  return dt.toUTC().toISO({ suppressMilliseconds: false }) as string;
}

const OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse an instant input. ISO strings with an explicit offset or `Z` are taken
 * as-is; a local ISO date-time (no offset) is interpreted in `tz`.
 * Returns ISO-8601 UTC.
 */
export function parseInstant(input: string, tz: string, field = "instant"): string {
  const s = input.trim();
  const opts: DateTimeOptions = OFFSET_RE.test(s) ? { setZone: true } : { zone: tz };
  let dt = DateTime.fromISO(s, opts);
  if (!dt.isValid) {
    // Allow "YYYY-MM-DD HH:mm" with a space.
    dt = DateTime.fromISO(s.replace(" ", "T"), opts);
  }
  if (!dt.isValid) {
    throw TodoCueError.validation(`invalid ${field}: ${input}`, { field, value: input, reason: dt.invalidExplanation });
  }
  return toUtcIso(dt);
}

export function isoToDate(iso: string): Date {
  return new Date(iso);
}

/** Local calendar date (YYYY-MM-DD) of an instant in tz. */
export function localDateOf(instant: Date | string, tz: string): string {
  const dt = (typeof instant === "string" ? DateTime.fromISO(instant) : DateTime.fromJSDate(instant)).setZone(tz);
  return dt.toISODate() as string;
}

export function localIsoOf(instant: Date | string, tz: string): string {
  const dt = (typeof instant === "string" ? DateTime.fromISO(instant) : DateTime.fromJSDate(instant)).setZone(tz);
  return dt.toISO({ includeOffset: false, suppressMilliseconds: true }) as string;
}

/** ISO weekday (1=Mon..7=Sun) of a local date. */
export function weekdayOf(date: string): number {
  return DateTime.fromISO(date, { zone: "UTC" }).weekday;
}

export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: "UTC" }).plus({ days }).toISODate() as string;
}

export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function assertDate(date: string, field: string): string {
  const dt = DateTime.fromISO(date, { zone: "UTC" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !dt.isValid) {
    throw TodoCueError.validation(`invalid ${field}: ${date}`, { field, value: date });
  }
  return date;
}

/**
 * Combine a local date and HH:mm in tz into a UTC instant.
 * DST rules: a non-existent local time is shifted forward to the next valid
 * time (luxon behaviour); an ambiguous local time resolves to its first occurrence.
 */
export function localDateTimeToUtc(date: string, time: string, tz: string): string {
  const [h, m] = time.split(":").map((x) => Number.parseInt(x, 10));
  const base = DateTime.fromISO(date, { zone: tz });
  if (!base.isValid) throw TodoCueError.validation(`invalid date: ${date}`);
  // Setting hour/minute on a DateTime in a zone handles gaps by moving forward.
  let dt = base.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (dt.hour !== h || dt.minute !== m) {
    // Fell into a DST gap: luxon shifted us; keep the shifted (next valid) time.
    // Nothing else to do — dt is already the first valid instant after the gap.
  } else {
    // Ambiguous time (fall back): luxon picks the earlier offset (first occurrence) by default.
    // Verify by constructing from the earlier offset explicitly.
    const earlier = DateTime.fromObject({ year: base.year, month: base.month, day: base.day, hour: h, minute: m }, { zone: tz });
    if (earlier.isValid && earlier.toMillis() < dt.toMillis()) dt = earlier;
  }
  return toUtcIso(dt);
}

/** Start of the local day as UTC instant. */
export function startOfLocalDay(date: string, tz: string): string {
  return toUtcIso(DateTime.fromISO(date, { zone: tz }).startOf("day"));
}

/** End of the local day (exclusive: start of next day) as UTC instant. */
export function endOfLocalDay(date: string, tz: string): string {
  return toUtcIso(DateTime.fromISO(date, { zone: tz }).plus({ days: 1 }).startOf("day"));
}

export function formatLocal(instant: string, tz: string, fmt = "yyyy-LL-dd HH:mm"): string {
  return DateTime.fromISO(instant).setZone(tz).toFormat(fmt);
}
