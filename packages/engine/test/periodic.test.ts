import { describe, expect, it } from "vitest";
import { CreatePeriodicReminderInput, normalizePeriodicConfig } from "@todocue/shared";
import { MemoryNotifier, nextPeriodicAt, Scheduler, TaskEngine } from "../src/index.js";
import { makeEngine } from "./helpers.js";

const input = { title: "起来活动一下", intervalMinutes: 30 };
/** Follow-ups are off unless a test asks for them, so the older tests keep exercising the bare timer. */
function fixture(mode: "fixed" | "after_completion" = "fixed", followUpMinutes = 0) {
  const { engine, clock, db } = makeEngine();
  const notifier = new MemoryNotifier();
  const reminder = engine.periodic.create({ ...input, mode, followUpMinutes });
  return { engine, clock, db, notifier, reminder };
}
async function offer(f: ReturnType<typeof fixture>, at = "2026-09-07T01:30:00Z") {
  f.clock.set(at); await f.engine.periodic.tick(f.notifier);
  return f.engine.periodic.get(f.reminder.id).currentOccurrence!;
}
function claim(f: ReturnType<typeof fixture>, occurrence: Awaited<ReturnType<typeof offer>>) {
  const request = { occurrenceId: occurrence.id, round: occurrence.round, token: "app-one" };
  f.engine.periodic.claim(f.reminder.id, request);
  f.engine.periodic.receipt(f.reminder.id, { ...request, displayed: true });
  return request;
}

describe("periodic reminders", () => {
  it("shares defaults, normalizes config and never creates tasks/series/task reminders", () => {
    const f = fixture();
    expect(f.reminder.weekdays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(f.reminder.nextFireAt).toBe("2026-09-07T01:30:00.000Z");
    expect(f.reminder.summary).toBe("每天 · 09:00–18:00 · 每 30 分钟");
    expect(f.engine.listTasks()).toEqual([]);
    expect(f.engine.listSeries()).toEqual([]);
    expect(f.engine.listReminders()).toEqual([]);
    expect(f.engine.periodic.preview(input).nextFireAt).toBe(f.reminder.nextFireAt);
  });
  it("advances state revisions at the same clock instant without changing configuration version", async () => {
    const f = fixture();
    const occurrence = await offer(f);
    const offered = f.engine.periodic.get(f.reminder.id);
    const request = { occurrenceId: occurrence.id, round: occurrence.round, token: "revision-app" };
    const claimed = f.engine.periodic.claim(f.reminder.id, request);
    const displayed = f.engine.periodic.receipt(f.reminder.id, { ...request, displayed: true });
    expect(claimed.updatedAt).toBe(offered.updatedAt);
    expect(claimed.revision).toBeGreaterThan(offered.revision);
    expect(displayed.revision).toBeGreaterThan(claimed.revision);
    expect(displayed.version).toBe(f.reminder.version);
    expect(f.engine.periodic.receipt(f.reminder.id, { ...request, displayed: true }).revision).toBe(displayed.revision);
    const completed = f.engine.periodic.action(f.reminder.id, { action: "complete", occurrenceId: occurrence.id });
    expect("revision" in completed && completed.revision).toBeGreaterThan(displayed.revision);
    const system = fixture(); await offer(system);
    const beforeSystem = system.engine.periodic.get(system.reminder.id).revision;
    system.clock.set("2026-09-07T01:30:03Z"); await system.engine.periodic.tick(system.notifier);
    expect(system.engine.periodic.get(system.reminder.id).revision).toBeGreaterThan(beforeSystem);
    // Older persisted rules remain readable and acquire a revision on their next mutation.
    const legacy = system.engine.periodic.get(system.reminder.id);
    const { revision: _, ...withoutRevision } = legacy;
    system.db.prepare("UPDATE periodic_reminders SET data = ? WHERE id = ?").run(JSON.stringify(withoutRevision), legacy.id);
    expect(system.engine.periodic.get(legacy.id).revision).toBe(0);
    expect(system.engine.periodic.update(legacy.id, { title: "legacy" }).revision).toBe(1);
  });
  it("validates interval, days, overlap, overnight, timezone and end-only 24:00", () => {
    const f = fixture();
    for (const patch of [{ intervalMinutes: 0 }, { weekdays: [] }, { weekdays: [1, 1] }, { timezone: "fake/zone" },
      { windows: [{ start: "18:00", end: "09:00" }] }, { windows: [{ start: "09:00", end: "09:30" }] },
      { windows: [{ start: "24:00", end: "24:00" }] },
      { windows: [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "18:00" }] }]) {
      expect(() => f.engine.periodic.create({ ...input, ...patch })).toThrow();
    }
    expect(f.engine.periodic.create({ ...input, windows: [{ start: "00:00", end: "24:00" }] }).windows[0]!.end).toBe("24:00");
    expect(CreatePeriodicReminderInput.parse(input)).toEqual(input);
  });
  it("keeps the fixed grid when completing and excludes the end boundary", async () => {
    const f = fixture(); const occurrence = await offer(f); claim(f, occurrence);
    f.clock.set("2026-09-07T01:42:00Z");
    f.engine.periodic.action(f.reminder.id, { action: "complete", occurrenceId: occurrence.id });
    expect(f.engine.periodic.get(f.reminder.id).nextFireAt).toBe("2026-09-07T02:00:00.000Z");
    f.clock.set("2026-09-07T09:30:00Z");
    expect(f.engine.periodic.preview(input).nextFireAt).toBe("2026-09-08T01:30:00.000Z");
  });
  it("waits for confirmation, counts from completion and ignores duplicate completion", async () => {
    const f = fixture("after_completion"); const occurrence = await offer(f); claim(f, occurrence);
    f.clock.set("2026-09-07T01:42:00Z");
    const action = { action: "complete" as const, occurrenceId: occurrence.id, round: occurrence.round };
    f.engine.periodic.action(f.reminder.id, action);
    expect(f.engine.periodic.get(f.reminder.id).nextFireAt).toBe("2026-09-07T02:12:00.000Z");
    f.clock.set("2026-09-07T01:50:00Z"); f.engine.periodic.action(f.reminder.id, action);
    expect(f.engine.periodic.get(f.reminder.id).nextFireAt).toBe("2026-09-07T02:12:00.000Z");
  });
  it("retains waiting over lunch, resets on next active day, supports weekends", async () => {
    const f = fixture("after_completion"); const occurrence = await offer(f); claim(f, occurrence);
    f.clock.set("2026-09-07T06:00:00Z"); await f.engine.periodic.tick(f.notifier);
    expect(f.engine.periodic.get(f.reminder.id).state).toBe("waiting");
    expect(f.engine.periodic.get(f.reminder.id).nextFireAt).toBeNull();
    f.clock.set("2026-09-08T01:00:00Z"); await f.engine.periodic.tick(f.notifier);
    expect(f.engine.periodic.get(f.reminder.id).nextFireAt).toBe("2026-09-08T01:30:00.000Z");
    const weekend = f.engine.periodic.create({ ...input, weekdays: [7, 6] });
    expect(weekend.weekdays).toEqual([6, 7]);
    expect(weekend.nextFireAt).toBe("2026-09-12T01:30:00.000Z");
  });
  it("rejects yesterday's card immediately on a new active day, before the next scheduler tick", async () => {
    const f = fixture("after_completion"); const occurrence = await offer(f); claim(f, occurrence);
    f.clock.set("2026-09-08T01:00:00Z");
    expect(() => f.engine.periodic.action(f.reminder.id, { action: "complete", occurrenceId: occurrence.id })).toThrow();
    await f.engine.periodic.tick(f.notifier);
    expect(f.engine.periodic.get(f.reminder.id).nextFireAt).toBe("2026-09-08T01:30:00.000Z");
  });
  it("moves rolling reminders out of lunch, with one full interval in the next window", async () => {
    const f = fixture("after_completion");
    f.engine.periodic.update(f.reminder.id, { windows: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "18:00" }] });
    const occurrence = await offer(f); claim(f, occurrence);
    f.clock.set("2026-09-07T03:50:00Z"); f.engine.periodic.action(f.reminder.id, { action: "complete", occurrenceId: occurrence.id });
    expect(f.engine.periodic.get(f.reminder.id).nextFireAt).toBe("2026-09-07T05:30:00.000Z");
  });
  it("offers once, selects exactly one channel, and fails an interrupted notch claim without fallback", async () => {
    const f = fixture(); const occurrence = await offer(f);
    await f.engine.periodic.tick(f.notifier); expect(f.notifier.delivered).toHaveLength(0);
    const request = { occurrenceId: occurrence.id, round: occurrence.round, token: "app" };
    f.engine.periodic.claim(f.reminder.id, request);
    expect(() => f.engine.periodic.claim(f.reminder.id, { ...request, token: "other" })).toThrow();
    f.clock.advance(11_000); await f.engine.periodic.tick(f.notifier);
    expect(f.notifier.delivered).toHaveLength(0);
    expect(f.engine.periodic.occurrence(occurrence.id).delivery).toBe("failed");
  });
  it("falls back after three seconds, silently, and rejects late claims", async () => {
    const f = fixture("after_completion"); const occurrence = await offer(f);
    f.clock.advance(3000); await f.engine.periodic.tick(f.notifier);
    expect(f.notifier.delivered).toHaveLength(1);
    expect(f.notifier.delivered[0]).toMatchObject({ periodicId: f.reminder.id, occurrenceId: occurrence.id, sound: false });
    expect(() => f.engine.periodic.claim(f.reminder.id, { occurrenceId: occurrence.id, round: 1, token: "late" })).toThrow();
    await f.engine.periodic.tick(f.notifier); expect(f.notifier.delivered).toHaveLength(1);
    expect(f.engine.periodic.get(f.reminder.id).state).toBe("waiting");
  });
  it("restarts from persisted state, never catches up and never replays a claimed delivery", async () => {
    const f = fixture("after_completion"); const occurrence = await offer(f); claim(f, occurrence);
    const engine = new TaskEngine({ db: f.db, clock: f.clock, timezone: "Asia/Shanghai" });
    await engine.periodic.tick(f.notifier, true);
    expect(engine.periodic.get(f.reminder.id).state).toBe("waiting");
    expect(f.notifier.delivered).toHaveLength(0);
    const second = engine.periodic.create({ ...input, title: "drink" });
    f.clock.set("2026-09-07T04:00:00Z"); await engine.periodic.tick(f.notifier, true);
    expect(engine.periodic.get(second.id).nextFireAt).toBe("2026-09-07T04:30:00.000Z");
    expect(f.notifier.delivered).toHaveLength(0);
  });
  it("snoozes one occurrence and merges into the next fixed slot", async () => {
    const f = fixture(); const occurrence = await offer(f); claim(f, occurrence);
    f.clock.set("2026-09-07T01:55:00Z"); f.engine.periodic.action(f.reminder.id, { action: "snooze", occurrenceId: occurrence.id });
    expect(f.engine.periodic.get(f.reminder.id).nextFireAt).toBe("2026-09-07T02:00:00.000Z");
    expect(f.engine.periodic.get(f.reminder.id).currentOccurrenceId).toBeNull();
    expect(f.engine.periodic.occurrence(occurrence.id).result).toBe("expired");
  });
  it("snooze creates a new delivery round and blocks stale buttons", async () => {
    const f = fixture("after_completion"); const occurrence = await offer(f); claim(f, occurrence);
    f.engine.periodic.action(f.reminder.id, { action: "snooze", occurrenceId: occurrence.id, round: 1 });
    expect(() => f.engine.periodic.action(f.reminder.id, { action: "complete", occurrenceId: occurrence.id, round: 1 })).toThrow();
    expect(f.engine.periodic.get(f.reminder.id).nextFireAt).toBe("2026-09-07T01:40:00.000Z");
    const snoozed = await offer(f, "2026-09-07T01:40:00Z");
    expect(snoozed.id).toBe(occurrence.id); expect(snoozed.round).toBe(2);
    claim(f, snoozed);
  });
  it("edit, pause and delete invalidate old instances and use version guards", async () => {
    const f = fixture(); const occurrence = await offer(f); claim(f, occurrence);
    f.engine.periodic.update(f.reminder.id, { intervalMinutes: 60, expectedVersion: 1 });
    expect(() => f.engine.periodic.action(f.reminder.id, { action: "complete", occurrenceId: occurrence.id })).toThrow();
    expect(() => f.engine.periodic.update(f.reminder.id, { title: "old", expectedVersion: 1 })).toThrow();
    f.engine.periodic.action(f.reminder.id, { action: "pause_today", expectedVersion: 2 });
    expect(f.engine.periodic.get(f.reminder.id).state).toBe("paused_today");
    f.clock.set("2026-09-08T01:00:00Z"); await f.engine.periodic.tick(f.notifier);
    expect(f.engine.periodic.get(f.reminder.id).nextFireAt).toBe("2026-09-08T02:00:00.000Z");
    f.engine.periodic.action(f.reminder.id, { action: "delete" });
    expect(f.engine.periodic.list()).toEqual([]);
  });
  it("scheduler integrates periodic offers without changing task reminder delivery", async () => {
    const f = fixture();
    f.engine.createTask({ title: "task", reminderAt: "2026-09-07T09:30" });
    const scheduler = new Scheduler({ engine: f.engine, notifier: f.notifier });
    f.clock.set("2026-09-07T01:30:00Z"); await scheduler.tick();
    expect(f.notifier.delivered).toHaveLength(1); expect(f.notifier.delivered[0]!.title).toBe("task");
    f.clock.advance(5000); await scheduler.tick(); expect(f.notifier.delivered).toHaveLength(2);
  });
  it("expires an unclaimed offer on restart even before its fallback deadline", async () => {
    const f = fixture("after_completion"); const occurrence = await offer(f);
    f.clock.advance(500); await f.engine.periodic.tick(f.notifier, true);
    f.clock.advance(5000); await f.engine.periodic.tick(f.notifier);
    expect(f.notifier.delivered).toHaveLength(0);
    expect(f.engine.periodic.occurrence(occurrence.id).delivery).toBe("missed");
    expect(f.engine.periodic.get(f.reminder.id).state).toBe("scheduled");
  });
  it("keeps failed delivery visible and schedules another interval without false confirmation", async () => {
    const f = fixture("after_completion"); const occurrence = await offer(f);
    f.notifier.failNext = "notifications denied";
    f.clock.advance(3000); await f.engine.periodic.tick(f.notifier);
    const rule = f.engine.periodic.get(f.reminder.id);
    expect(rule.currentOccurrence?.lastError).toBe("notifications denied");
    expect(rule.currentOccurrence?.delivery).toBe("failed");
    expect(rule.currentOccurrence?.result).toBe("expired");
    expect(rule.state).toBe("scheduled"); expect(rule.nextFireAt).toBe("2026-09-07T02:00:03.000Z");
    expect(() => f.engine.periodic.action(rule.id, { action: "complete", occurrenceId: occurrence.id })).toThrow();
  });
  it("does not resurrect a rule deleted during asynchronous system delivery", async () => {
    const f = fixture(); await offer(f); f.clock.advance(3000);
    const original = f.notifier.deliver.bind(f.notifier);
    f.notifier.deliver = async (payload) => {
      f.engine.periodic.action(f.reminder.id, { action: "delete" });
      return original(payload);
    };
    await f.engine.periodic.tick(f.notifier);
    expect(f.engine.periodic.list()).toEqual([]);
    expect(f.db.prepare("SELECT count(*) AS n FROM periodic_occurrences").get()).toEqual({ n: 0 });
  });
  it("uses each rule's local date rather than runtime date", () => {
    const f = fixture(); f.clock.set("2026-09-07T23:00:00Z"); // Tuesday in Shanghai, Monday in LA.
    const rule = f.engine.periodic.create({ ...input, timezone: "America/Los_Angeles", weekdays: [1] });
    expect(rule.stateDate).toBe("2026-09-07");
    expect(rule.nextFireAt).toBe("2026-09-07T23:30:00.000Z");
  });
  it("rechecks active hours before every asynchronous system delivery", async () => {
    const { engine, clock, notifier } = makeEngine({ now: "2026-09-07T01:58:30Z" });
    for (const title of ["one", "two"]) engine.periodic.create({ title, intervalMinutes: 1, mode: "fixed", windows: [{ start: "09:00", end: "10:00" }] });
    clock.set("2026-09-07T01:59:00Z"); await engine.periodic.tick(notifier); clock.advance(3000);
    const sent: string[] = [];
    notifier.deliver = async () => { sent.push(clock.now().toISOString()); clock.set("2026-09-07T02:00:01Z"); return "memory"; };
    await engine.periodic.tick(notifier);
    expect(sent).toEqual(["2026-09-07T01:59:03.000Z"]);
    expect(engine.periodic.list().filter((r) => r.currentOccurrence?.delivery === "missed")).toHaveLength(1);
  });
  it("does not carry a snooze into the next local active day in either timing mode", async () => {
    for (const mode of ["fixed", "after_completion"] as const) {
      const { engine, clock, notifier } = makeEngine({ now: "2026-09-07T15:00:00Z" });
      const rule = engine.periodic.create({ ...input, mode, windows: [{ start: "00:00", end: "24:00" }] });
      clock.set("2026-09-07T15:30:00Z"); await engine.periodic.tick(notifier);
      const occurrence = engine.periodic.get(rule.id).currentOccurrence!;
      const request = { occurrenceId: occurrence.id, round: 1, token: "app" };
      engine.periodic.claim(rule.id, request); engine.periodic.receipt(rule.id, { ...request, displayed: true });
      clock.set("2026-09-07T15:55:00Z"); engine.periodic.action(rule.id, { action: "snooze", occurrenceId: occurrence.id });
      expect(engine.periodic.get(rule.id).nextFireAt).not.toBe("2026-09-07T16:05:00.000Z");
      clock.set("2026-09-07T16:00:00Z"); await engine.periodic.tick(notifier);
      expect(engine.periodic.get(rule.id).nextFireAt).toBe("2026-09-07T16:30:00.000Z");
    }
  });
  it("repairs a previously persisted cross-day snooze while retaining normal future first slots", async () => {
    const { engine, clock, notifier, db } = makeEngine({ now: "2026-09-07T15:00:00Z" });
    const rule = engine.periodic.create({ ...input, mode: "after_completion", windows: [{ start: "00:00", end: "24:00" }] });
    clock.set("2026-09-07T15:30:00Z"); await engine.periodic.tick(notifier);
    const occurrence = engine.periodic.get(rule.id).currentOccurrence!;
    // A persisted record from the earlier implementation, before cross-day snooze validation.
    occurrence.delivery = "scheduled"; occurrence.round = 2; occurrence.fireAt = "2026-09-07T16:05:00.000Z";
    db.prepare("UPDATE periodic_occurrences SET data = ? WHERE id = ?").run(JSON.stringify(occurrence), occurrence.id);
    const raw = JSON.parse((db.prepare("SELECT data FROM periodic_reminders WHERE id = ?").get(rule.id) as { data: string }).data);
    raw.nextFireAt = occurrence.fireAt;
    db.prepare("UPDATE periodic_reminders SET data = ? WHERE id = ?").run(JSON.stringify(raw), rule.id);
    clock.set("2026-09-07T16:00:00Z"); await engine.periodic.tick(notifier);
    expect(engine.periodic.get(rule.id).nextFireAt).toBe("2026-09-07T16:30:00.000Z");
    expect(engine.periodic.occurrence(occurrence.id).result).toBe("expired");
    const future = engine.periodic.create({ ...input, mode: "after_completion" });
    clock.set("2026-09-08T16:00:00Z"); await engine.periodic.tick(notifier);
    expect(engine.periodic.get(future.id).nextFireAt).toBe("2026-09-09T01:30:00.000Z");
  });
  it("keeps valid rolling candidates when a DST window end is nonexistent", () => {
    const config = normalizePeriodicConfig({ ...input, mode: "after_completion", timezone: "America/New_York", windows: [{ start: "01:00", end: "02:00" }] }, "UTC");
    expect(nextPeriodicAt(config, new Date("2026-03-08T06:00:00Z"))).toBe("2026-03-08T06:30:00.000Z");
  });
  it("restarts a rolling interval at the next active segment after a DST fold", () => {
    const config = normalizePeriodicConfig({ ...input, mode: "after_completion", timezone: "America/New_York", windows: [{ start: "01:30", end: "03:00" }] }, "UTC");
    expect(nextPeriodicAt(config, new Date("2026-11-01T05:40:00Z"))).toBe("2026-11-01T07:00:00.000Z");
    const split = normalizePeriodicConfig({ ...input, intervalMinutes: 15, mode: "after_completion", timezone: "America/New_York", windows: [{ start: "01:00", end: "01:20" }, { start: "01:30", end: "01:50" }] }, "UTC");
    expect(nextPeriodicAt(split, new Date("2026-11-01T05:10:00Z"))).toBe("2026-11-01T05:45:00.000Z");
  });
  it("skips nonexistent DST slots and picks a folded wall-clock slot only once", () => {
    const config = normalizePeriodicConfig({ ...input, mode: "fixed", timezone: "America/New_York", windows: [{ start: "01:00", end: "04:00" }] }, "UTC");
    expect(nextPeriodicAt(config, new Date("2026-03-08T06:30:00Z"))).toBe("2026-03-08T07:00:00.000Z");
    expect(nextPeriodicAt(config, new Date("2026-11-01T05:30:00Z"))).toBe("2026-11-01T07:00:00.000Z");
  });
  it("new rules are habit rules that re-ask after ten minutes, and say so in the summary", () => {
    const { engine } = makeEngine();
    const rule = engine.periodic.create(input);
    expect(rule).toMatchObject({ mode: "after_completion", followUpMinutes: 10 });
    expect(rule.summary).toBe("每天 · 09:00–18:00 · 每 30 分钟（完成后重新计时，没响应 10 分钟后再提醒）");
    expect(engine.periodic.create({ ...input, followUpMinutes: 0 }).summary).toBe("每天 · 09:00–18:00 · 每 30 分钟（完成后重新计时）");
    expect(() => engine.periodic.create({ ...input, followUpMinutes: 121 })).toThrow();
    expect(() => engine.periodic.create({ ...input, followUpMinutes: -1 })).toThrow();
  });
  it("re-asks an ignored habit cue as the next round of the same occurrence, at most three times", async () => {
    const f = fixture("after_completion", 10); const occurrence = await offer(f); claim(f, occurrence);
    f.clock.set("2026-09-07T01:39:00Z"); await f.engine.periodic.tick(f.notifier);
    expect(f.engine.periodic.get(f.reminder.id).currentOccurrence).toMatchObject({ id: occurrence.id, round: 1, followUps: 0 });
    for (const [round, at] of [[2, "01:40:00"], [3, "01:50:00"], [4, "02:00:00"]] as const) {
      // The tick that decides to re-ask schedules it; the next tick (5 s later in production) offers it.
      f.clock.set(`2026-09-07T${at}Z`); await f.engine.periodic.tick(f.notifier); await f.engine.periodic.tick(f.notifier);
      const current = f.engine.periodic.get(f.reminder.id).currentOccurrence!;
      expect(current).toMatchObject({ id: occurrence.id, round, followUps: round - 1, delivery: "offered", result: "pending" });
      claim(f, current);
    }
    f.clock.set("2026-09-07T05:00:00Z"); await f.engine.periodic.tick(f.notifier);
    const waiting = f.engine.periodic.get(f.reminder.id);
    expect(waiting.state).toBe("waiting");
    expect(waiting.currentOccurrence).toMatchObject({ id: occurrence.id, round: 4, followUps: 3, delivery: "displayed" });
    expect(waiting.nextFireAt).toBeNull();
    expect(f.engine.periodic.history(f.reminder.id)).toHaveLength(1);
  });
  it("does not re-ask when follow-ups are off, for fixed rules, outside the window, or after a snooze that has not fired", async () => {
    const off = fixture("after_completion", 0); claim(off, await offer(off));
    off.clock.set("2026-09-07T03:00:00Z"); await off.engine.periodic.tick(off.notifier);
    expect(off.engine.periodic.get(off.reminder.id).currentOccurrence?.round).toBe(1);
    const fixed = fixture("fixed", 10); claim(fixed, await offer(fixed));
    fixed.clock.set("2026-09-07T01:45:00Z"); await fixed.engine.periodic.tick(fixed.notifier);
    expect(fixed.engine.periodic.get(fixed.reminder.id).currentOccurrence?.followUps).toBe(0);
    const closing = fixture("after_completion", 10);
    closing.engine.periodic.update(closing.reminder.id, { windows: [{ start: "09:00", end: "09:45" }] });
    claim(closing, await offer(closing));
    closing.clock.set("2026-09-07T01:46:00Z"); await closing.engine.periodic.tick(closing.notifier);
    expect(closing.engine.periodic.get(closing.reminder.id).currentOccurrence).toMatchObject({ round: 1, followUps: 0 });
    const snoozed = fixture("after_completion", 10); const first = await offer(snoozed); claim(snoozed, first);
    snoozed.engine.periodic.action(snoozed.reminder.id, { action: "snooze", occurrenceId: first.id, round: 1, minutes: 20 });
    snoozed.clock.set("2026-09-07T01:49:00Z"); await snoozed.engine.periodic.tick(snoozed.notifier);
    expect(snoozed.engine.periodic.get(snoozed.reminder.id).currentOccurrence).toMatchObject({ round: 2, delivery: "scheduled" });
  });
  it("a snooze counts as an answer and gives the occurrence a fresh set of follow-ups", async () => {
    const f = fixture("after_completion", 10); const first = await offer(f); claim(f, first);
    f.clock.set("2026-09-07T01:40:00Z"); await f.engine.periodic.tick(f.notifier); await f.engine.periodic.tick(f.notifier);
    const second = f.engine.periodic.get(f.reminder.id).currentOccurrence!; claim(f, second);
    expect(second.followUps).toBe(1);
    f.engine.periodic.action(f.reminder.id, { action: "snooze", occurrenceId: second.id, round: second.round, minutes: 5 });
    expect(f.engine.periodic.get(f.reminder.id).currentOccurrence).toMatchObject({ round: 3, followUps: 0, delivery: "scheduled" });
  });
  it("rules saved before followUpMinutes existed read as the default", () => {
    const f = fixture("after_completion");
    const { followUpMinutes: _, ...legacy } = f.engine.periodic.get(f.reminder.id);
    f.db.prepare("UPDATE periodic_reminders SET data = ? WHERE id = ?").run(JSON.stringify(legacy), legacy.id);
    expect(f.engine.periodic.get(legacy.id).followUpMinutes).toBe(10);
    expect(f.engine.periodic.list()[0]!.followUpMinutes).toBe(10);
    expect(f.engine.periodic.update(legacy.id, { title: "legacy" }).followUpMinutes).toBe(10);
  });
  it("being away counts as the break: closes a pending cue, restarts the habit timer, leaves fixed rules alone", async () => {
    const habit = fixture("after_completion", 10); claim(habit, await offer(habit));
    const fixedRule = habit.engine.periodic.create({ ...input, mode: "fixed" });
    const fixedNext = fixedRule.nextFireAt;
    habit.clock.set("2026-09-07T01:50:00Z");
    expect(habit.engine.periodic.away({ minutes: 5 })).toEqual({ reset: [habit.reminder.id] });
    const after = habit.engine.periodic.get(habit.reminder.id);
    expect(after).toMatchObject({ state: "scheduled", currentOccurrence: null, nextFireAt: "2026-09-07T02:20:00.000Z" });
    expect(habit.engine.periodic.history(habit.reminder.id)[0]).toMatchObject({ result: "completed", handledVia: "away" });
    expect(habit.engine.periodic.get(fixedRule.id).nextFireAt).toBe(fixedNext);
    // Counting down with nothing pending: the timer simply restarts from the moment of return.
    habit.clock.set("2026-09-07T02:10:00Z"); habit.engine.periodic.away({ minutes: 8 });
    expect(habit.engine.periodic.get(habit.reminder.id).nextFireAt).toBe("2026-09-07T02:40:00.000Z");
  });
  it("away is ignored for paused, disabled and out-of-window rules and for absences shorter than the minimum", async () => {
    const f = fixture("after_completion"); const before = f.engine.periodic.get(f.reminder.id).nextFireAt;
    expect(() => f.engine.periodic.away({ minutes: 2 })).toThrow();
    f.clock.set("2026-09-07T01:10:00Z"); f.engine.periodic.action(f.reminder.id, { action: "pause_today" });
    expect(f.engine.periodic.away({ minutes: 10 })).toEqual({ reset: [] });
    f.engine.periodic.action(f.reminder.id, { action: "resume" });
    f.clock.set("2026-09-07T11:00:00Z"); // 19:00 local, after the window
    expect(f.engine.periodic.away({ minutes: 10 })).toEqual({ reset: [] });
    expect(before).toBe("2026-09-07T01:30:00.000Z");
  });
  it("counts the user's snoozes separately from automatic follow-ups", async () => {
    const f = fixture("after_completion", 10); const first = await offer(f); claim(f, first);
    f.clock.set("2026-09-07T01:40:00Z"); await f.engine.periodic.tick(f.notifier); await f.engine.periodic.tick(f.notifier);
    const second = f.engine.periodic.get(f.reminder.id).currentOccurrence!; claim(f, second);
    expect(second).toMatchObject({ round: 2, followUps: 1, snoozes: 0 });
    f.engine.periodic.action(f.reminder.id, { action: "snooze", occurrenceId: second.id, round: second.round, minutes: 5 });
    // One snooze after one follow-up: three rounds, but exactly one snooze.
    expect(f.engine.periodic.get(f.reminder.id).currentOccurrence).toMatchObject({ round: 3, followUps: 0, snoozes: 1 });
  });
  it("a startup or wake pass restarts the follow-up wait instead of re-asking on the next tick", async () => {
    const f = fixture("after_completion", 10); const occurrence = await offer(f); claim(f, occurrence);
    f.clock.set("2026-09-07T03:00:00Z"); await f.engine.periodic.tick(f.notifier, true);   // the laptop was closed for 90 minutes
    f.clock.advance(5000); await f.engine.periodic.tick(f.notifier);
    expect(f.engine.periodic.get(f.reminder.id).currentOccurrence).toMatchObject({ id: occurrence.id, round: 1, followUps: 0, delivery: "displayed" });
    f.clock.set("2026-09-07T03:09:00Z"); await f.engine.periodic.tick(f.notifier);
    expect(f.engine.periodic.get(f.reminder.id).currentOccurrence?.round).toBe(1);
    f.clock.set("2026-09-07T03:10:06Z"); await f.engine.periodic.tick(f.notifier);
    expect(f.engine.periodic.get(f.reminder.id).currentOccurrence).toMatchObject({ round: 2, followUps: 1 });
    // The overdue clock is the original due time, untouched by the wake.
    expect(f.engine.periodic.get(f.reminder.id).currentOccurrence?.scheduledAt).toBe("2026-09-07T01:30:00.000Z");
  });
});
