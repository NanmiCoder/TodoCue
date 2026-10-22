import { describe, expect, it } from "vitest";
import { Scheduler } from "../src/index.js";
import { makeEngine } from "./helpers.js";

const REMIND = "2026-09-07T09:01"; // 01:01Z, engine runs in Asia/Shanghai

describe("reminder delivery reliability", () => {
  it("does not announce an already delivered reminder again after an unrelated edit", async () => {
    const { engine, clock, notifier, scheduler } = makeEngine();
    const { task } = engine.createTask({ title: "a", reminderAt: REMIND });
    clock.set("2026-09-07T01:01:01.000Z");
    await scheduler.tick();
    expect(notifier.delivered).toHaveLength(1);

    engine.updateTask(task.id, { title: "renamed", expectedVersion: engine.getTask(task.id).version });
    expect(engine.listReminders({ taskId: task.id }).map((r) => r.status)).toEqual(["submitted"]);
    clock.advance(10_000);
    await scheduler.tick();
    expect(notifier.delivered).toHaveLength(1);
  });

  it("still arms a reminder whose time actually changed", async () => {
    const { engine, clock, notifier, scheduler } = makeEngine();
    const { task } = engine.createTask({ title: "a", reminderAt: REMIND });
    clock.set("2026-09-07T01:01:01.000Z");
    await scheduler.tick();
    engine.updateTask(task.id, { reminderAt: "2026-09-07T10:00", expectedVersion: engine.getTask(task.id).version });
    clock.set("2026-09-07T02:00:01.000Z");
    await scheduler.tick();
    expect(notifier.delivered).toHaveLength(2);
  });

  it("keeps retrying a reminder over hours of notification failure and delivers it once it recovers", async () => {
    const { engine, clock, notifier } = makeEngine();
    const scheduler = new Scheduler({ engine, notifier, tickMs: 1000 });
    const { task } = engine.createTask({ title: "a", reminderAt: REMIND });
    clock.set("2026-09-07T01:01:01.000Z");
    const failing = notifier.deliver.bind(notifier);
    notifier.deliver = async () => { throw new Error("notifications denied"); };
    for (let i = 0; i < 40; i++) {
      await scheduler.tick();
      clock.advance(5 * 60_000); // ~3h20m, many more attempts than the old cap of 3
    }
    const mid = engine.listReminders({ taskId: task.id })[0]!;
    expect(mid.status).toBe("pending");
    expect(mid.lastError).toBe("notifications denied");
    expect(engine.reminderDiagnostics().retrying).toBe(1);

    notifier.deliver = failing;
    clock.advance(16 * 60_000);
    await scheduler.tick();
    expect(engine.listReminders({ taskId: task.id })[0]!.status).toBe("missed");
    expect(notifier.delivered).toHaveLength(1);
    expect(notifier.delivered[0]!.body).toContain("错过的提醒");
  });

  it("gives up after the window and re-queues recent failures on startup", async () => {
    const { engine, clock, notifier } = makeEngine();
    const scheduler = new Scheduler({ engine, notifier, tickMs: 1000, giveUpAfterMs: 10 * 60_000, retryDelaysMs: [1_000] });
    const { task } = engine.createTask({ title: "a", reminderAt: REMIND });
    clock.set("2026-09-07T01:01:01.000Z");
    notifier.deliver = async () => { throw new Error("denied"); };
    clock.advance(11 * 60_000);
    await scheduler.tick();
    expect(engine.listReminders({ taskId: task.id })[0]!.status).toBe("failed");

    // Permission granted again: a restart (or wake) puts the recent failure back in the queue.
    const delivered: string[] = [];
    notifier.deliver = async (p) => { delivered.push(p.title); return "memory"; };
    expect(engine.requeueFailedReminders(24 * 3_600_000)).toBe(1);
    await scheduler.tick();
    expect(delivered).toEqual(["a"]);

    // An old failure outside the window stays failed, and a changed task is never revived.
    const old = engine.createTask({ title: "old", reminderAt: "2026-09-07T09:20" }).task;
    const changed = engine.createTask({ title: "changed", reminderAt: "2026-09-07T09:21" }).task;
    notifier.deliver = async () => { throw new Error("denied"); };
    clock.advance(30 * 60_000);
    await scheduler.tick();
    clock.advance(11 * 60_000);
    await scheduler.tick();
    engine.completeTask(changed.id);
    clock.advance(25 * 3_600_000);
    expect(engine.requeueFailedReminders(24 * 3_600_000)).toBe(0);
    expect(engine.listReminders({ taskId: old.id })[0]!.status).toBe("failed");
  });

  it("a cancelled reminder is not turned back into submitted by a late delivery receipt", async () => {
    const { engine, clock, notifier } = makeEngine();
    const { task } = engine.createTask({ title: "a", reminderAt: REMIND });
    clock.set("2026-09-07T01:01:01.000Z");
    const reminder = engine.listReminders({ taskId: task.id })[0]!;
    engine.completeTask(task.id);
    engine.markReminderSubmitted(reminder.id, "helper");
    engine.markReminderFailed(reminder.id, "late failure");
    expect(engine.listReminders({ taskId: task.id })[0]!.status).toBe("cancelled");
    expect(notifier.delivered).toHaveLength(0);
  });

  it("a slow delivery pass is not mistaken for a sleep/wake gap", async () => {
    const { engine, clock, notifier } = makeEngine();
    const logs: string[] = [];
    const scheduler = new Scheduler({ engine, notifier, tickMs: 1000, sleepGapMs: 30_000, log: (m) => logs.push(m) });
    engine.createTask({ title: "slow", reminderAt: REMIND });
    clock.set("2026-09-07T01:01:01.000Z");
    const deliver = notifier.deliver.bind(notifier);
    notifier.deliver = async (p) => { clock.advance(40_000); return deliver(p); }; // helper took 40s in total
    await scheduler.tick();
    clock.advance(5_000);
    await scheduler.tick();
    expect(logs.some((m) => m.includes("sleep/wake"))).toBe(false);
  });
});
