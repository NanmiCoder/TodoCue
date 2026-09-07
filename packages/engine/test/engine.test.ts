import { describe, expect, it } from "vitest";
import { TodoCueError } from "@todocue/shared";
import { makeEngine } from "./helpers.js";

describe("tasks", () => {
  it("creates a task with local time interpreted in the timezone", () => {
    const { engine } = makeEngine();
    const { task } = engine.createTask({ title: "写周报", scheduledAt: "2026-09-07T10:00:00", reminderAt: "2026-09-07T09:50" });
    expect(task.scheduledAt).toBe("2026-09-07T02:00:00.000Z");
    expect(task.reminderAt).toBe("2026-09-07T01:50:00.000Z");
    expect(task.scheduledDate).toBeNull();
    expect(task.timezone).toBe("Asia/Shanghai");
    expect(engine.listReminders({ status: "pending" })).toHaveLength(1);
  });

  it("keeps date-level plans at date precision and enforces exclusivity", () => {
    const { engine } = makeEngine();
    const { task } = engine.createTask({ title: "a", scheduledDate: "2026-09-08", dueDate: "2026-09-09" });
    expect(task.scheduledDate).toBe("2026-09-08");
    expect(task.scheduledAt).toBeNull();
    expect(() => engine.createTask({ title: "b", scheduledDate: "2026-09-08", scheduledAt: "2026-09-08T10:00" })).toThrow(TodoCueError);
    const updated = engine.updateTask(task.id, { scheduledAt: "2026-09-08T15:00" });
    expect(updated.scheduledDate).toBeNull();
    expect(updated.scheduledAt).toBe("2026-09-08T07:00:00.000Z");
  });

  it("enforces version checks", () => {
    const { engine } = makeEngine();
    const { task } = engine.createTask({ title: "a" });
    const v2 = engine.updateTask(task.id, { title: "b", expectedVersion: 1 });
    expect(v2.version).toBe(2);
    expect(() => engine.updateTask(task.id, { title: "c", expectedVersion: 1 })).toThrowError(/version conflict/);
    try {
      engine.completeTask(task.id, { expectedVersion: 1 });
    } catch (e) {
      expect((e as TodoCueError).code).toBe("VERSION_CONFLICT");
      expect((e as TodoCueError).details).toMatchObject({ expectedVersion: 1, currentVersion: 2 });
    }
  });

  it("complete cancels pending reminders; reopen does not resend past reminders", () => {
    const { engine, clock } = makeEngine();
    const { task } = engine.createTask({ title: "a", reminderAt: "2026-09-07T09:30" });
    expect(engine.listReminders({ status: "pending" })).toHaveLength(1);
    engine.completeTask(task.id);
    expect(engine.listReminders({ status: "pending" })).toHaveLength(0);
    expect(engine.listReminders({ status: "cancelled" })).toHaveLength(1);
    clock.set("2026-09-07T02:00:00.000Z"); // 10:00, reminder time passed
    const reopened = engine.reopenTask(task.id);
    expect(reopened.status).toBe("todo");
    expect(engine.listReminders({ status: "pending" })).toHaveLength(0);
    // but a future reminder is restored
    const { task: t2 } = engine.createTask({ title: "b", reminderAt: "2026-09-07T18:00" });
    engine.completeTask(t2.id);
    engine.reopenTask(t2.id);
    expect(engine.listReminders({ status: "pending", taskId: t2.id })).toHaveLength(1);
  });

  it("snooze only moves the reminder", () => {
    const { engine } = makeEngine();
    const { task } = engine.createTask({ title: "a", scheduledDate: "2026-09-07", reminderAt: "2026-09-07T09:05" });
    const s = engine.snoozeTask(task.id, { minutes: 15 });
    expect(s.reminderAt).toBe("2026-09-07T01:15:00.000Z");
    expect(s.scheduledDate).toBe("2026-09-07");
    const pending = engine.listReminders({ status: "pending", taskId: task.id });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.fireAt).toBe("2026-09-07T01:15:00.000Z");
    expect(engine.listReminders({ status: "cancelled", taskId: task.id })).toHaveLength(1);
  });

  it("skip only applies to series instances", () => {
    const { engine } = makeEngine();
    const { task } = engine.createTask({ title: "a" });
    expect(() => engine.skipTask(task.id)).toThrowError(/series instances/);
  });

  it("emits events after commit", () => {
    const { engine } = makeEngine();
    const events: string[] = [];
    engine.onEvent((e) => events.push(e.type));
    engine.createTask({ title: "a", reminderAt: "2026-09-07T12:00" });
    expect(events).toEqual(["task.created", "reminder.updated"]);
  });
});

describe("today / next", () => {
  it("classifies today's items and orders sections", () => {
    const { engine } = makeEngine(); // 2026-09-07 09:00 local
    engine.createTask({ title: "overdue", dueDate: "2026-09-06" });
    engine.createTask({ title: "due today", dueDate: "2026-09-07", priority: "low" });
    engine.createTask({ title: "scheduled today high", scheduledDate: "2026-09-07", priority: "high" });
    engine.createTask({ title: "carried over", scheduledDate: "2026-09-05" });
    engine.createTask({ title: "tomorrow", scheduledDate: "2026-09-08" });
    engine.createTask({ title: "unscheduled" });
    const today = engine.todayView();
    expect(today.date).toBe("2026-09-07");
    expect(today.items.map((i) => i.task.title)).toEqual(["overdue", "due today", "scheduled today high", "carried over"]);
    expect(today.items.map((i) => i.section)).toEqual(["overdue", "must", "scheduled", "scheduled"]);
    expect(today.items[3]!.reasons).toEqual(["carried_over"]);
    expect(today.remaining).toBe(4);
  });

  it("next excludes future-scheduled tasks and groups correctly", () => {
    const { engine } = makeEngine();
    engine.createTask({ title: "later today", scheduledAt: "2026-09-07T15:00" });
    engine.createTask({ title: "unscheduled high", priority: "high" });
    engine.createTask({ title: "reached", scheduledAt: "2026-09-07T08:00" });
    engine.createTask({ title: "due today", dueAt: "2026-09-07T18:00" });
    engine.createTask({ title: "overdue", dueAt: "2026-09-07T08:30" });
    const next = engine.nextView();
    expect(next.candidates.map((c) => c.task.title)).toEqual(["overdue", "due today", "reached", "unscheduled high"]);
    expect(next.next!.group).toBe("overdue");
    expect(next.next!.reason).toContain("逾期");
  });

  it("completed list uses the actual completion date", () => {
    const { engine, clock } = makeEngine();
    const { task } = engine.createTask({ title: "a", scheduledDate: "2026-09-06" });
    clock.set("2026-09-06T14:00:00.000Z"); // 22:00 on the 6th local
    engine.completeTask(task.id);
    clock.set("2026-09-07T01:00:00.000Z");
    expect(engine.todayView().completed).toHaveLength(0);
    clock.set("2026-09-06T15:00:00.000Z");
    expect(engine.todayView().completed.map((t) => t.id)).toEqual([task.id]);
  });
});

describe("series", () => {
  it("generates daily instances 30 days ahead and tops up across days", () => {
    const { engine, clock } = makeEngine();
    const { series, tasks } = engine.createSeries({ title: "站会", rule: { kind: "daily" }, scheduledTime: "09:30", reminderTime: "09:25" });
    expect(tasks).toHaveLength(31);
    expect(tasks[0]!.occurrenceDate).toBe("2026-09-07");
    expect(tasks[0]!.scheduledAt).toBe("2026-09-07T01:30:00.000Z");
    expect(series.generatedThrough).toBe("2026-10-07");
    clock.set("2026-09-08T01:00:00.000Z");
    expect(engine.ensureSeriesInstances()).toBe(1);
    expect(engine.getSeriesTasks(series.id)).toHaveLength(32);
  });

  it("yesterday's unfinished instance does not block today's", () => {
    const { engine, clock } = makeEngine({ now: "2026-09-06T01:00:00.000Z" });
    const { series } = engine.createSeries({ title: "喝水", rule: { kind: "daily" } });
    clock.set("2026-09-07T01:00:00.000Z");
    const today = engine.todayView();
    const items = today.items.filter((i) => i.task.seriesId === series.id);
    expect(items.map((i) => [i.task.occurrenceDate, i.reasons[0]])).toEqual([
      ["2026-09-06", "carried_over"],
      ["2026-09-07", "scheduled_today"],
    ]);
  });

  it("weekly rules generate only chosen weekdays; reschedule and skip affect one instance", () => {
    const { engine } = makeEngine(); // 2026-09-07 is a Monday
    const { series, tasks } = engine.createSeries({ title: "健身", rule: { kind: "weekly", weekdays: [1, 3] } });
    expect(tasks.map((t) => t.occurrenceDate).slice(0, 4)).toEqual(["2026-09-07", "2026-09-09", "2026-09-14", "2026-09-16"]);
    const moved = engine.updateTask(tasks[0]!.id, { scheduledDate: "2026-09-08" });
    expect(moved.occurrenceDate).toBe("2026-09-07");
    expect(engine.getTask(tasks[1]!.id).scheduledDate).toBe("2026-09-09");
    const skipped = engine.skipTask(tasks[1]!.id);
    expect(skipped.status).toBe("skipped");
    expect(engine.getSeries(series.id).status).toBe("active");
  });

  it("stop cancels future instances and keeps today and history", () => {
    const { engine, clock } = makeEngine({ now: "2026-09-06T01:00:00.000Z" });
    const { series, tasks } = engine.createSeries({ title: "读书", rule: { kind: "daily" } });
    engine.completeTask(tasks[0]!.id);
    clock.set("2026-09-07T01:00:00.000Z");
    const res = engine.stopSeries(series.id);
    expect(res.series.status).toBe("stopped");
    const all = engine.getSeriesTasks(series.id);
    expect(all.find((t) => t.occurrenceDate === "2026-09-06")!.status).toBe("done");
    expect(all.find((t) => t.occurrenceDate === "2026-09-07")!.status).toBe("todo");
    expect(all.filter((t) => t.status === "cancelled")).toHaveLength(all.length - 2);
    expect(res.cancelledTaskIds).toHaveLength(all.length - 2);
    clock.set("2026-09-08T01:00:00.000Z");
    expect(engine.ensureSeriesInstances()).toBe(0);
  });

  it("createTask with repeat creates a series and returns the first instance", () => {
    const { engine } = makeEngine();
    const res = engine.createTask({ title: "晨跑", repeat: { kind: "daily" }, scheduledAt: "2026-09-08T06:30", reminderAt: "2026-09-08T06:00" });
    expect(res.series!.scheduledTime).toBe("06:30");
    expect(res.series!.reminderTime).toBe("06:00");
    expect(res.series!.startDate).toBe("2026-09-08");
    expect(res.task.occurrenceDate).toBe("2026-09-08");
  });

  it("keeps local time across DST and resolves gaps forward", () => {
    // America/New_York: 2026-03-08 02:00 -> 03:00 (gap); 2026-11-01 02:00 -> 01:00 (overlap)
    const { engine } = makeEngine({ now: "2026-03-06T15:00:00.000Z", tz: "America/New_York", horizonDays: 5 });
    const { tasks } = engine.createSeries({ title: "dst", rule: { kind: "daily" }, scheduledTime: "02:30" });
    const byDate = Object.fromEntries(tasks.map((t) => [t.occurrenceDate, t.scheduledAt]));
    expect(byDate["2026-03-07"]).toBe("2026-03-07T07:30:00.000Z"); // EST, UTC-5
    expect(byDate["2026-03-08"]).toBe("2026-03-08T07:30:00.000Z"); // 02:30 does not exist -> 03:30 EDT (UTC-4)
    expect(byDate["2026-03-09"]).toBe("2026-03-09T06:30:00.000Z"); // EDT
    const e2 = makeEngine({ now: "2026-10-31T15:00:00.000Z", tz: "America/New_York", horizonDays: 2 });
    const r2 = e2.engine.createSeries({ title: "dst2", rule: { kind: "daily" }, scheduledTime: "01:30" });
    const m = Object.fromEntries(r2.tasks.map((t) => [t.occurrenceDate, t.scheduledAt]));
    expect(m["2026-11-01"]).toBe("2026-11-01T05:30:00.000Z"); // first occurrence (EDT)
  });
});

describe("scheduler", () => {
  it("delivers reminders on time, cancels stale ones, and summarises missed ones", async () => {
    const { engine, clock, notifier, scheduler } = makeEngine();
    const { task } = engine.createTask({ title: "a", reminderAt: "2026-09-07T09:10" });
    engine.createTask({ title: "b", reminderAt: "2026-09-07T09:20" });
    engine.createTask({ title: "c", reminderAt: "2026-09-07T09:21" });
    await scheduler.tick(true);
    expect(notifier.delivered).toHaveLength(0);
    clock.set("2026-09-07T01:10:05.000Z");
    await scheduler.tick();
    expect(notifier.delivered.map((d) => d.id)).toEqual([task.id]);
    expect(engine.listReminders({ status: "submitted" })).toHaveLength(1);
    // Machine sleeps past b and c.
    clock.set("2026-09-07T02:00:00.000Z");
    await scheduler.tick();
    expect(notifier.delivered).toHaveLength(2);
    expect(notifier.delivered[1]!.title).toContain("2");
    expect(engine.listReminders({ status: "missed" })).toHaveLength(2);
  });

  it("retries failed deliveries and gives up after max attempts", async () => {
    const { engine, clock, notifier, scheduler } = makeEngine();
    engine.createTask({ title: "a", reminderAt: "2026-09-07T09:01" });
    clock.set("2026-09-07T01:01:01.000Z");
    notifier.failNext = "boom";
    await scheduler.tick();
    let r = engine.listReminders()[0]!;
    expect(r.status).toBe("pending");
    expect(r.attempts).toBe(1);
    expect(r.lastError).toBe("boom");
    await scheduler.tick();
    expect(notifier.delivered).toHaveLength(0); // backoff not elapsed
    clock.advance(31_000);
    await scheduler.tick();
    r = engine.listReminders()[0]!;
    expect(r.status).toBe("submitted");
    expect(notifier.delivered).toHaveLength(1);
  });

  it("does not deliver reminders for tasks completed before the time", async () => {
    const { engine, clock, notifier, scheduler } = makeEngine();
    const { task } = engine.createTask({ title: "a", reminderAt: "2026-09-07T09:01" });
    engine.completeTask(task.id);
    clock.set("2026-09-07T01:02:00.000Z");
    await scheduler.tick();
    expect(notifier.delivered).toHaveLength(0);
  });

  it("emits day.changed and generates instances on rollover", async () => {
    const { engine, clock, scheduler } = makeEngine();
    const events: string[] = [];
    engine.onEvent((e) => events.push(e.type));
    engine.createSeries({ title: "x", rule: { kind: "daily" } });
    await scheduler.tick();
    clock.set("2026-09-07T16:00:01.000Z"); // 00:00:01 next day local
    await scheduler.tick();
    expect(events).toContain("day.changed");
    expect(engine.listSeries()[0]!.generatedThrough).toBe("2026-10-08");
  });
});

describe("idempotency store", () => {
  it("stores, replays and prunes", () => {
    const { engine, clock } = makeEngine();
    engine.idempotencyPut("k", "h", 201, "{}");
    expect(engine.idempotencyGet("k")).toEqual({ requestHash: "h", statusCode: 201, body: "{}" });
    clock.advance(25 * 3600_000);
    expect(engine.pruneIdempotency()).toBe(1);
    expect(engine.idempotencyGet("k")).toBeNull();
  });
});
