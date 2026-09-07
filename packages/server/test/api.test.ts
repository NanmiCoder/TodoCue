import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeClock, MemoryNotifier } from "@todocue/engine";
import { TodoCueClient, startRuntime, type RunningRuntime } from "../src/index.js";
import { silentLogger } from "../src/logger.js";
import type { RuntimeEvent } from "@todocue/shared";

let rt: RunningRuntime;
let client: TodoCueClient;
const clock = new FakeClock("2026-09-07T01:00:00.000Z");
const notifier = new MemoryNotifier();

beforeAll(async () => {
  process.env.TODOCUE_TZ = "Asia/Shanghai";
  rt = await startRuntime({ memory: true, clock, notifier, logger: silentLogger, tickMs: 100 });
  client = new TodoCueClient({ baseUrl: rt.baseUrl, token: rt.token });
});
afterAll(async () => {
  await rt.stop();
});

describe("local api", () => {
  it("rejects missing token", async () => {
    const res = await fetch(`${rt.baseUrl}/v1/today`);
    expect(res.status).toBe(401);
    const health = await fetch(`${rt.baseUrl}/v1/health`);
    expect(health.status).toBe(200);
  });

  it("creates, lists, updates, completes with version checks", async () => {
    const { task } = await client.createTask({ title: "写周报", dueDate: "2026-09-07", priority: "high" });
    expect(task.version).toBe(1);
    const today = await client.today();
    expect(today.items.map((i) => i.task.id)).toContain(task.id);
    expect(today.items[0]!.section).toBe("must");
    const { task: t2 } = await client.updateTask(task.id, { title: "写周报（改）", expectedVersion: 1 });
    expect(t2.version).toBe(2);
    await expect(client.completeTask(task.id, { expectedVersion: 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    const { task: done } = await client.completeTask(task.id, { expectedVersion: 2 });
    expect(done.status).toBe("done");
    const next = await client.next();
    expect(next.candidates.find((c) => c.task.id === task.id)).toBeUndefined();
  });

  it("validates input", async () => {
    await expect(client.createTask({ title: "" } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(client.getTask("t_nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("supports idempotent creates", async () => {
    const key = `k-${Date.now()}`;
    const a = await client.createTask({ title: "幂等" }, { idempotencyKey: key });
    const b = await client.createTask({ title: "幂等" }, { idempotencyKey: key });
    expect(b.task.id).toBe(a.task.id);
    await expect(client.createTask({ title: "不同" }, { idempotencyKey: key })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    const list = await client.listTasks({ q: "幂等" });
    expect(list.tasks).toHaveLength(1);
  });

  it("streams events over SSE", async () => {
    const events: RuntimeEvent[] = [];
    const ac = new AbortController();
    const stream = client.events((e) => events.push(e), { signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    const { task } = await client.createTask({ title: "sse", reminderAt: "2026-09-07T09:05" });
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await stream;
    expect(events.map((e) => e.type)).toContain("runtime.started");
    expect(events.find((e) => e.type === "task.created" && e.id === task.id)).toBeTruthy();
    expect(events.find((e) => e.type === "reminder.updated" && e.related?.taskId === task.id)).toBeTruthy();
  });

  it("delivers reminders via the scheduler and reports in doctor", async () => {
    const { task } = await client.createTask({ title: "提醒我", reminderAt: "2026-09-07T09:10" });
    clock.set("2026-09-07T01:10:01.000Z");
    await new Promise((r) => setTimeout(r, 400));
    expect(notifier.delivered.some((d) => d.id === task.id)).toBe(true);
    const reminders = await client.listReminders({ taskId: task.id });
    expect(reminders.reminders[0]!.status).toBe("submitted");
    const doctor = await client.doctor();
    expect(doctor.notifier.authorization).toBe("authorized");
    expect(doctor.counts.tasks).toBeGreaterThan(0);
    expect(doctor.checks.find((c) => c.name === "notifier")!.ok).toBe(true);
  });

  it("series endpoints", async () => {
    const created = await client.createSeries({ title: "站会", rule: { kind: "weekly", weekdays: [1, 2, 3, 4, 5] }, scheduledTime: "09:30" });
    expect(created.tasks.length).toBeGreaterThan(20);
    const list = await client.listSeries("active");
    expect(list.series.map((s) => s.id)).toContain(created.series.id);
    const stopped = await client.stopSeries(created.series.id, { expectedVersion: 1 });
    expect(stopped.series.status).toBe("stopped");
    expect(stopped.cancelledTaskIds.length).toBeGreaterThan(0);
    const exp = await client.export();
    expect(exp.format).toBe("todocue-export");
    expect(exp.series.length).toBeGreaterThan(0);
  });
});

describe("query parsing", () => {
  it("handles includeUnscheduled=false and repeated status params", async () => {
    await client.createTask({ title: "no plan at all" });
    const res = await fetch(`${rt.baseUrl}/v1/tasks?includeUnscheduled=false&from=2026-09-01`, { headers: { Authorization: `Bearer ${rt.token}` } });
    const body = (await res.json()) as { tasks: { title: string }[] };
    expect(body.tasks.find((t) => t.title === "no plan at all")).toBeUndefined();
    const rem = await fetch(`${rt.baseUrl}/v1/reminders?status=pending&status=submitted`, { headers: { Authorization: `Bearer ${rt.token}` } });
    expect(rem.status).toBe(200);
  });
});
