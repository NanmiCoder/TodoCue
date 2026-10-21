import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import {
  CreatePeriodicReminderInput, UpdatePeriodicReminderInput, PeriodicActionInput,
  normalizePeriodicConfig, periodicSummary, minuteOfDay, TodoCueError, PeriodicAwayInput,
  PERIODIC_DEFAULTS, PERIODIC_MAX_FOLLOW_UPS,
  type PeriodicConfig, type PeriodicReminder, type PeriodicOccurrence, type EventType,
} from "@todocue/shared";
import type { SqliteDatabase } from "./db.js";
import type { Clock } from "./time.js";
import { assertTimezone, localDateOf, toUtcIso } from "./time.js";
import type { NotificationSink } from "./notifier.js";

// State is persisted separately from the response-only summary and current-instance expansion.
type Rule = Omit<PeriodicReminder, "summary" | "state" | "currentOccurrence">;
type Emit = (type: EventType, id: string, related?: Record<string, string>) => void;
const iso = (millis: number) => toUtcIso(new Date(millis));
const millis = (value: string) => new Date(value).getTime();
const OPEN = new Set<PeriodicOccurrence["delivery"]>(["scheduled", "offered", "claimed", "displayed", "submitted"]);

/** Resolve a wall-clock slot once; skip gaps and choose the first offset in a fold. */
function wallTime(date: string, minute: number, timezone: string): number | null {
  if (minute === 1440) return DateTime.fromISO(date, { zone: timezone }).plus({ days: 1 }).startOf("day").toMillis();
  const hour = Math.floor(minute / 60), min = minute % 60;
  const dt = DateTime.fromISO(date, { zone: timezone }).set({ hour, minute: min, second: 0, millisecond: 0 });
  if (!dt.isValid || dt.hour !== hour || dt.minute !== min) return null;
  return Math.min(...dt.getPossibleOffsets().map((d) => d.toMillis()));
}

export function periodicIsActive(config: PeriodicConfig, at: Date): boolean {
  const dt = DateTime.fromJSDate(at).setZone(config.timezone);
  const minute = dt.hour * 60 + dt.minute;
  return config.weekdays.includes(dt.weekday) && config.windows.some((w) => minute >= minuteOfDay(w.start) && minute < minuteOfDay(w.end));
}

/** Actual active UTC segments, including windows cut by DST gaps or folds. */
function activeSegments(config: PeriodicConfig, date: string): { start: number; end: number }[] {
  const day = DateTime.fromISO(date, { zone: config.timezone }).startOf("day");
  const start = day.toMillis(), end = day.plus({ days: 1 }).startOf("day").toMillis();
  if (end - start === 86400_000) {
    return config.windows.flatMap((window) => {
      const a = wallTime(date, minuteOfDay(window.start), config.timezone);
      const b = wallTime(date, minuteOfDay(window.end), config.timezone);
      return a === null || b === null ? [] : [{ start: a, end: b }];
    });
  }
  const segments: { start: number; end: number }[] = [];
  for (const window of config.windows) {
    const a = minuteOfDay(window.start), b = minuteOfDay(window.end);
    let segment: { start: number; end: number } | undefined;
    for (let at = start; at < end; at += 60_000) {
      const local = DateTime.fromMillis(at, { zone: config.timezone });
      const minute = local.hour * 60 + local.minute;
      if (minute >= a && minute < b) {
        if (!segment) { segment = { start: at, end: at }; segments.push(segment); }
        segment.end = at + 60_000;
      } else segment = undefined;
    }
  }
  return segments.sort((a, b) => a.start - b.start);
}

/** All callers (preview, creation, edits, completion and scheduler) use the same calculation. */
export function nextPeriodicAt(config: PeriodicConfig, after: Date): string {
  const now = after.getTime();
  const base = DateTime.fromJSDate(after).setZone(config.timezone).startOf("day");
  for (let day = 0; day < 15; day++) {
    const localDay = base.plus({ days: day });
    if (!config.weekdays.includes(localDay.weekday)) continue;
    const date = localDay.toISODate()!;
    if (config.mode === "after_completion") {
      const candidates = activeSegments(config, date).flatMap((segment) => {
        const candidate = Math.max(now, segment.start) + config.intervalMinutes * 60_000;
        return candidate < segment.end ? [candidate] : [];
      });
      if (candidates.length) return iso(Math.min(...candidates));
    } else {
      for (const window of config.windows) {
        for (let minute = minuteOfDay(window.start) + config.intervalMinutes; minute < minuteOfDay(window.end); minute += config.intervalMinutes) {
          const candidate = wallTime(date, minute, config.timezone);
          if (candidate !== null && candidate > now) return iso(candidate);
        }
      }
    }
  }
  throw TodoCueError.validation("接下来两周没有可用的提醒时间，请调整时段或间隔");
}

export class PeriodicStore {
  private events: Parameters<Emit>[] = [];
  constructor(private db: SqliteDatabase, private clock: Clock, private timezone: string, private emit: Emit) {}
  private now() { return this.clock.now(); }
  private nowIso() { return toUtcIso(this.now()); }
  private transaction<T>(fn: () => T): T {
    this.events = [];
    try {
      const result = this.db.transaction(fn)();
      const events = this.events;
      this.events = [];
      for (const event of events) this.emit(...event);
      return result;
    } catch (error) { this.events = []; throw error; }
  }
  private changed(rule: Rule, type: EventType = "periodic.updated") { this.events.push([type, rule.id]); }
  /** Rules saved before followUpMinutes existed read as the default, so they pick up the follow-up too. */
  private hydrate(data: string): Rule {
    return { revision: 0, followUpMinutes: PERIODIC_DEFAULTS.followUpMinutes, ...JSON.parse(data) } as Rule;
  }
  private raw(id: string): Rule {
    const row = this.db.prepare("SELECT data FROM periodic_reminders WHERE id = ?").get(id) as { data: string } | undefined;
    if (!row) throw TodoCueError.notFound("periodic reminder", id);
    return this.hydrate(row.data);
  }
  private save(rule: Rule) {
    rule.revision = (rule.revision ?? 0) + 1;
    rule.updatedAt = this.nowIso();
    this.db.prepare("INSERT INTO periodic_reminders(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(rule.id, JSON.stringify(rule));
  }
  occurrence(id: string): PeriodicOccurrence {
    const row = this.db.prepare("SELECT data FROM periodic_occurrences WHERE id = ?").get(id) as { data: string } | undefined;
    if (!row) throw TodoCueError.notFound("periodic occurrence", id);
    return JSON.parse(row.data) as PeriodicOccurrence;
  }
  private saveOccurrence(value: PeriodicOccurrence) {
    value.updatedAt = this.nowIso();
    this.db.prepare(`INSERT INTO periodic_occurrences(id, rule_id, rule_version, scheduled_at, data) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(value.id, value.ruleId, value.ruleVersion, value.scheduledAt, JSON.stringify(value));
  }
  private expand(rule: Rule): PeriodicReminder {
    const currentOccurrence = rule.currentOccurrenceId ? this.occurrence(rule.currentOccurrenceId) : null;
    const today = localDateOf(this.now(), rule.timezone);
    return { ...rule, summary: periodicSummary(rule), currentOccurrence,
      state: !rule.enabled ? "paused" : rule.pausedOn === today ? "paused_today"
        : rule.mode === "after_completion" && !rule.nextFireAt && currentOccurrence?.result === "pending"
          && ["displayed", "submitted", "claimed", "offered"].includes(currentOccurrence.delivery) ? "waiting" : "scheduled" };
  }
  get(id: string): PeriodicReminder { return this.expand(this.raw(id)); }
  list(query?: string): PeriodicReminder[] {
    const rows = this.db.prepare("SELECT data FROM periodic_reminders ORDER BY id").all() as { data: string }[];
    return rows.map((r) => this.expand(this.hydrate(r.data))).filter((r) => !query || r.title.toLowerCase().includes(query.toLowerCase()));
  }
  history(id: string): PeriodicOccurrence[] {
    this.raw(id);
    return (this.db.prepare("SELECT data FROM periodic_occurrences WHERE rule_id = ? ORDER BY scheduled_at DESC LIMIT 200").all(id) as { data: string }[])
      .map((row) => JSON.parse(row.data) as PeriodicOccurrence);
  }
  preview(input: CreatePeriodicReminderInput): { config: PeriodicConfig; summary: string; nextFireAt: string | null } {
    const config = normalizePeriodicConfig(CreatePeriodicReminderInput.parse(input), this.timezone);
    assertTimezone(config.timezone);
    return { config, summary: periodicSummary(config), nextFireAt: config.enabled ? nextPeriodicAt(config, this.now()) : null };
  }
  create(input: CreatePeriodicReminderInput): PeriodicReminder {
    const preview = this.preview(input);
    return this.transaction(() => {
      const rule: Rule = { ...preview.config, id: `p_${randomUUID()}`, version: 1, revision: 0, pausedOn: null,
        stateDate: localDateOf(this.now(), preview.config.timezone), nextFireAt: preview.nextFireAt,
        currentOccurrenceId: null, createdAt: this.nowIso(), updatedAt: this.nowIso() };
      this.save(rule); this.changed(rule, "periodic.created");
      return this.expand(rule);
    });
  }
  private checkVersion(rule: Rule, expected?: number) {
    if (expected !== undefined && rule.version !== expected) throw TodoCueError.conflict(rule.id, expected, rule.version);
  }
  private newActiveDay(rule: Rule): boolean {
    const local = DateTime.fromJSDate(this.now()).setZone(rule.timezone);
    return rule.stateDate !== local.toISODate() && rule.weekdays.includes(local.weekday);
  }
  private expireCurrent(rule: Rule, cancelled = false) {
    if (rule.currentOccurrenceId) {
      const occurrence = this.occurrence(rule.currentOccurrenceId);
      if (occurrence.result === "pending") {
        occurrence.result = cancelled ? "cancelled" : "expired";
        if (cancelled && OPEN.has(occurrence.delivery)) occurrence.delivery = "cancelled";
        this.saveOccurrence(occurrence);
      }
    }
    rule.currentOccurrenceId = null;
  }
  update(id: string, input: UpdatePeriodicReminderInput): PeriodicReminder {
    const patch = UpdatePeriodicReminderInput.parse(input);
    return this.transaction(() => {
      const rule = this.raw(id); this.checkVersion(rule, patch.expectedVersion);
      const { expectedVersion: _, ...fields } = patch;
      const config = normalizePeriodicConfig({ title: rule.title, intervalMinutes: rule.intervalMinutes,
        weekdays: rule.weekdays, windows: rule.windows, mode: rule.mode, followUpMinutes: rule.followUpMinutes, timezone: rule.timezone, enabled: rule.enabled, ...fields }, this.timezone);
      assertTimezone(config.timezone);
      this.expireCurrent(rule, true);
      Object.assign(rule, config); rule.version++;
      rule.stateDate = localDateOf(this.now(), rule.timezone);
      rule.nextFireAt = rule.enabled && rule.pausedOn !== rule.stateDate ? nextPeriodicAt(rule, this.now()) : null;
      this.save(rule); this.changed(rule); return this.expand(rule);
    });
  }
  action(id: string, input: PeriodicActionInput): PeriodicReminder | { deleted: true; id: string } {
    const action = PeriodicActionInput.parse(input);
    return this.transaction(() => {
      const rule = this.raw(id); this.checkVersion(rule, action.expectedVersion);
      if (["pause", "resume", "pause_today", "delete"].includes(action.action)) {
        if (action.action === "delete") {
          this.db.prepare("DELETE FROM periodic_reminders WHERE id = ?").run(id);
          this.changed(rule); return { deleted: true as const, id };
        }
        this.expireCurrent(rule, true); rule.version++;
        if (action.action === "pause") rule.enabled = false;
        if (action.action === "resume") { rule.enabled = true; rule.pausedOn = null; }
        if (action.action === "pause_today") rule.pausedOn = localDateOf(this.now(), rule.timezone);
        rule.nextFireAt = rule.enabled && rule.pausedOn !== localDateOf(this.now(), rule.timezone) ? nextPeriodicAt(rule, this.now()) : null;
        rule.stateDate = localDateOf(this.now(), rule.timezone);
      } else {
        const occurrenceId = action.occurrenceId ?? rule.currentOccurrenceId;
        if (!occurrenceId) throw TodoCueError.invalidState("没有可处理的本次提醒");
        const occurrence = this.occurrence(occurrenceId);
        if (occurrence.ruleId !== id || occurrence.ruleVersion !== rule.version) throw TodoCueError.invalidState("这条提醒已经失效");
        if (occurrence.result === "completed" && action.action === "complete") return this.expand(rule);
        if (rule.currentOccurrenceId !== occurrenceId || occurrence.result !== "pending" || !rule.enabled
          || this.newActiveDay(rule)
          || rule.pausedOn === localDateOf(this.now(), rule.timezone)
          || (action.round !== undefined && action.round !== occurrence.round)) throw TodoCueError.invalidState("这条提醒已经失效");
        if (!["claimed", "displayed", "submitted"].includes(occurrence.delivery)) throw TodoCueError.invalidState("本次提醒尚未送达");
        if (action.action === "complete") {
          occurrence.result = "completed"; occurrence.handledAt = this.nowIso();
          rule.currentOccurrenceId = null;
          // Completing a snoozed fixed instance restores its original grid.
          rule.nextFireAt = nextPeriodicAt(rule, this.now());
        } else {
          const until = new Date(this.now().getTime() + (action.minutes ?? 10) * 60_000);
          if (!periodicIsActive(rule, until) || localDateOf(until, rule.timezone) !== localDateOf(new Date(occurrence.scheduledAt), rule.timezone)) {
            if (rule.mode === "fixed") { occurrence.result = "expired"; rule.currentOccurrenceId = null; rule.nextFireAt = nextPeriodicAt(rule, this.now()); }
            else rule.nextFireAt = null;
          } else if (rule.mode === "fixed" && rule.nextFireAt && millis(rule.nextFireAt) <= until.getTime()) {
            occurrence.result = "expired"; rule.currentOccurrenceId = null;
          } else {
            // Snoozing is an answer: the unanswered follow-up count starts over, the snooze count does not.
            this.rearm(rule, occurrence, until); occurrence.followUps = 0; occurrence.snoozes = (occurrence.snoozes ?? 0) + 1;
          }
        }
        this.saveOccurrence(occurrence);
      }
      this.save(rule); this.changed(rule); return this.expand(rule);
    });
  }
  /** Offers the same occurrence again at `at` as the next round (snooze and follow-up). */
  private rearm(rule: Rule, occurrence: PeriodicOccurrence, at: Date) {
    occurrence.fireAt = toUtcIso(at); occurrence.round++;
    occurrence.delivery = "scheduled"; occurrence.channel = null; occurrence.claimToken = null;
    occurrence.offeredAt = null; occurrence.claimedAt = null; occurrence.displayedAt = null;
    rule.nextFireAt = occurrence.fireAt;
  }
  /** A habit cue that was shown and ignored: ask again, a few times, instead of going quiet. */
  private followUpDue(rule: Rule, occurrence: PeriodicOccurrence): boolean {
    return rule.mode === "after_completion" && rule.followUpMinutes > 0 && occurrence.result === "pending"
      && (occurrence.delivery === "displayed" || occurrence.delivery === "submitted")
      && (occurrence.followUps ?? 0) < PERIODIC_MAX_FOLLOW_UPS && periodicIsActive(rule, this.now())
      && this.now().getTime() - millis(occurrence.fireAt) >= rule.followUpMinutes * 60_000;
  }
  /**
   * The user was away from the computer: for habit rules that is the break the cue asks for.
   * A pending cue is closed as completed (`handledVia: "away"`) and the timer restarts from now.
   */
  away(input: PeriodicAwayInput): { reset: string[] } {
    PeriodicAwayInput.parse(input);
    return this.transaction(() => {
      const reset: string[] = [];
      for (const item of this.list()) {
        const rule = this.raw(item.id), today = localDateOf(this.now(), rule.timezone);
        if (rule.mode !== "after_completion" || !rule.enabled || rule.pausedOn === today
          || this.newActiveDay(rule) || !periodicIsActive(rule, this.now())) continue;
        const occurrence = rule.currentOccurrenceId ? this.occurrence(rule.currentOccurrenceId) : null;
        if (occurrence?.result === "pending") {
          occurrence.result = "completed"; occurrence.handledAt = this.nowIso(); occurrence.handledVia = "away";
          this.saveOccurrence(occurrence);
        }
        rule.currentOccurrenceId = null;
        rule.nextFireAt = nextPeriodicAt(rule, this.now());
        this.save(rule); this.changed(rule); reset.push(rule.id);
      }
      return { reset };
    });
  }
  private newOccurrence(rule: Rule, at: string): PeriodicOccurrence {
    return { id: `po_${randomUUID()}`, ruleId: rule.id, ruleVersion: rule.version, scheduledAt: at,
      fireAt: at, round: 1, delivery: "scheduled", result: "pending", channel: null, offeredAt: null,
      claimToken: null, claimedAt: null, displayedAt: null, handledAt: null, lastError: null, followUps: 0, snoozes: 0,
      createdAt: this.nowIso(), updatedAt: this.nowIso() };
  }
  private current(id: string, occurrenceId: string, round: number): { rule: Rule; occurrence: PeriodicOccurrence } {
    const rule = this.raw(id), occurrence = this.occurrence(occurrenceId);
    if (rule.currentOccurrenceId !== occurrenceId || occurrence.ruleId !== id || occurrence.ruleVersion !== rule.version
      || occurrence.round !== round || occurrence.result !== "pending" || !rule.enabled
      || this.newActiveDay(rule)
      || rule.pausedOn === localDateOf(this.now(), rule.timezone)) throw TodoCueError.invalidState("这条提醒已经失效");
    return { rule, occurrence };
  }
  claim(id: string, input: { occurrenceId: string; round: number; token: string }): PeriodicReminder {
    return this.transaction(() => {
      const { rule, occurrence } = this.current(id, input.occurrenceId, input.round);
      if (occurrence.delivery === "claimed" && occurrence.channel === "notch" && occurrence.claimToken === input.token) return this.expand(rule);
      if (occurrence.delivery !== "offered" || !occurrence.offeredAt || this.now().getTime() - millis(occurrence.offeredAt) >= 3000
        || !periodicIsActive(rule, this.now())) throw TodoCueError.invalidState("本次投递已由其他通道处理");
      occurrence.delivery = "claimed"; occurrence.channel = "notch"; occurrence.claimToken = input.token; occurrence.claimedAt = this.nowIso();
      this.saveOccurrence(occurrence); this.save(rule); this.changed(rule); return this.expand(rule);
    });
  }
  receipt(id: string, input: { occurrenceId: string; round: number; token: string; displayed: boolean }): PeriodicReminder {
    return this.transaction(() => {
      const { rule, occurrence } = this.current(id, input.occurrenceId, input.round);
      if (occurrence.channel !== "notch" || occurrence.claimToken !== input.token) throw TodoCueError.invalidState("投递凭证不匹配");
      if (occurrence.delivery === "displayed") return this.expand(rule);
      if (occurrence.delivery !== "claimed") throw TodoCueError.invalidState("投递已结束");
      occurrence.delivery = input.displayed ? "displayed" : "failed";
      occurrence.displayedAt = input.displayed ? this.nowIso() : null;
      occurrence.lastError = input.displayed ? null : "App could not display the claimed cue";
      this.saveOccurrence(occurrence);
      if (!input.displayed) this.rearmFailed(rule, occurrence);
      else this.save(rule);
      this.changed(rule); return this.expand(rule);
    });
  }
  private rearmFailed(rule: Rule, occurrence: PeriodicOccurrence) {
    occurrence.result = "expired"; this.saveOccurrence(occurrence);
    // Keep the failed instance visible for diagnostics until the next occurrence replaces it.
    rule.currentOccurrenceId = occurrence.id; rule.nextFireAt = nextPeriodicAt(rule, this.now()); this.save(rule);
  }
  /** Offers and channel selection are transactions; OS delivery never holds the database lock. */
  async tick(notifier: NotificationSink, catchUp = false): Promise<void> {
    const deliveries = this.transaction(() => {
      const deliver: { rule: Rule; occurrence: PeriodicOccurrence }[] = [];
      for (const item of this.list()) {
        const rule = this.raw(item.id), today = localDateOf(this.now(), rule.timezone);
        if (!rule.enabled) continue;
        if (rule.stateDate !== today && rule.weekdays.includes(DateTime.fromJSDate(this.now()).setZone(rule.timezone).weekday)) {
          const oldOccurrence = rule.currentOccurrenceId ? this.occurrence(rule.currentOccurrenceId) : null;
          const oldSnooze = oldOccurrence?.delivery === "scheduled" && oldOccurrence.round > 1
            && localDateOf(new Date(oldOccurrence.scheduledAt), rule.timezone) !== today;
          this.expireCurrent(rule);
          rule.stateDate = today;
          // Preserve today's future first slot across a normal midnight rollover.
          if (oldSnooze || !rule.nextFireAt || millis(rule.nextFireAt) <= this.now().getTime()) rule.nextFireAt = nextPeriodicAt(rule, this.now());
          this.save(rule); this.changed(rule);
        }
        if (rule.pausedOn === today) continue;
        if (!rule.nextFireAt && !rule.currentOccurrenceId) {
          rule.nextFireAt = nextPeriodicAt(rule, this.now()); this.save(rule); this.changed(rule);
        }
        let occurrence = rule.currentOccurrenceId ? this.occurrence(rule.currentOccurrenceId) : null;
        if (rule.nextFireAt && millis(rule.nextFireAt) <= this.now().getTime()) {
          const at = rule.nextFireAt;
          if (!occurrence || occurrence.delivery !== "scheduled" || occurrence.fireAt !== at) {
            this.expireCurrent(rule);
            occurrence = this.newOccurrence(rule, at); rule.currentOccurrenceId = occurrence.id;
          }
          if (catchUp || this.now().getTime() - millis(at) >= 120_000 || !periodicIsActive(rule, this.now())) {
            occurrence.delivery = "missed"; occurrence.result = "expired";
            this.saveOccurrence(occurrence); rule.currentOccurrenceId = null;
            rule.nextFireAt = nextPeriodicAt(rule, this.now());
          } else {
            occurrence.delivery = "offered"; occurrence.offeredAt = this.nowIso();
            this.saveOccurrence(occurrence);
            rule.nextFireAt = rule.mode === "fixed" ? nextPeriodicAt(rule, this.now()) : null;
            this.events.push(["periodic.fired", rule.id, { occurrenceId: occurrence.id, round: String(occurrence.round) }]);
          }
          this.save(rule); this.changed(rule);
        }
        if (!occurrence || occurrence.result !== "pending") continue;
        if (occurrence.delivery === "claimed" && (catchUp || this.now().getTime() - millis(occurrence.claimedAt!) >= (occurrence.channel === "notch" ? 10_000 : 30_000))) {
          occurrence.delivery = "failed"; occurrence.lastError = "Claimed delivery interrupted before receipt";
          this.rearmFailed(rule, occurrence); this.changed(rule);
        } else if (occurrence.delivery === "offered" && (catchUp || this.now().getTime() - millis(occurrence.offeredAt!) >= 3000)) {
          if (!periodicIsActive(rule, this.now()) || catchUp) {
            occurrence.delivery = "missed"; this.rearmFailed(rule, occurrence); this.changed(rule);
          } else {
            occurrence.delivery = "claimed"; occurrence.channel = "system"; occurrence.claimedAt = this.nowIso();
            this.saveOccurrence(occurrence); this.save(rule); this.changed(rule); deliver.push({ rule, occurrence });
          }
        } else if (catchUp) {
          // Startup/wake: the time the machine was off is not time the user ignored the cue, so the
          // wait before the next follow-up starts over instead of firing on the very next tick.
          if (rule.mode === "after_completion" && occurrence.result === "pending"
            && (occurrence.delivery === "displayed" || occurrence.delivery === "submitted")) {
            occurrence.fireAt = this.nowIso(); this.saveOccurrence(occurrence);
          }
        } else if (this.followUpDue(rule, occurrence)) {
          this.rearm(rule, occurrence, this.now()); occurrence.followUps = (occurrence.followUps ?? 0) + 1;
          this.saveOccurrence(occurrence); this.save(rule); this.changed(rule);
        }
      }
      const cutoff = iso(this.now().getTime() - 30 * 86400_000);
      this.db.prepare(`DELETE FROM periodic_occurrences WHERE json_extract(data, '$.result') != 'pending'
        AND json_extract(data, '$.updatedAt') < ? AND id NOT IN
          (SELECT json_extract(data, '$.currentOccurrenceId') FROM periodic_reminders WHERE json_extract(data, '$.currentOccurrenceId') IS NOT NULL)`).run(cutoff);
      return deliver;
    });
    for (const { rule, occurrence } of deliveries) {
      let channel: string | null = null, error: string | null = null;
      // Revalidate after earlier asynchronous OS deliveries.
      let latest: { rule: Rule; occurrence: PeriodicOccurrence };
      try { latest = this.current(rule.id, occurrence.id, occurrence.round); } catch { continue; }
      if (latest.occurrence.delivery !== "claimed" || latest.occurrence.channel !== "system") continue;
      if (!periodicIsActive(latest.rule, this.now())) {
        this.transaction(() => {
          latest.occurrence.delivery = "missed";
          this.rearmFailed(latest.rule, latest.occurrence); this.changed(latest.rule);
        });
        continue;
      }
      try {
        channel = await notifier.deliver({ id: `periodic:${rule.id}`, title: latest.rule.title, body: periodicSummary(latest.rule),
          periodicId: rule.id, occurrenceId: occurrence.id, round: occurrence.round, sound: false, thread: "todocue.periodic" });
      } catch (e) { error = (e as Error).message; }
      this.transaction(() => {
        let current: { rule: Rule; occurrence: PeriodicOccurrence };
        try { current = this.current(rule.id, occurrence.id, occurrence.round); } catch { return; }
        if (current.occurrence.delivery !== "claimed" || current.occurrence.channel !== "system") return;
        current.occurrence.delivery = error ? "failed" : "submitted";
        current.occurrence.channel = channel ?? "system"; current.occurrence.lastError = error;
        this.saveOccurrence(current.occurrence);
        if (error) this.rearmFailed(current.rule, current.occurrence);
        else this.save(current.rule);
        this.changed(current.rule);
      });
    }
  }
}
