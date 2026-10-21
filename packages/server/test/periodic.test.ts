import { afterEach, describe, expect, it } from "vitest";
import { FakeClock, MemoryNotifier, openDatabase, TaskEngine } from "@todocue/engine";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });
function fixture() {
  const { db } = openDatabase({ path: ":memory:" });
  const clock = new FakeClock("2026-09-07T01:00:00Z");
  const notifier = new MemoryNotifier();
  const engine = new TaskEngine({ db, clock, timezone: "Asia/Shanghai" });
  app = buildApp({ engine, notifier, token: "test", doctorInfo: () => ({ home: "test", databasePath: ":memory:", schemaVersion: 4, baseUrl: "http://test" }) });
  const request = (method: "POST" | "PATCH" | "GET", path: string, payload?: unknown, key?: string) => app.inject({ method, url: `/v1/periodic-reminders${path}`,
    headers: { authorization: "Bearer test", ...(key ? { "idempotency-key": key } : {}) }, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });
  return { request, engine, clock, notifier };
}
const input = { title: "活动", intervalMinutes: 30 };
describe("periodic API", () => {
  it("creates in one call, shares preview defaults and protects idempotent retries", async () => {
    const f = fixture();
    expect((await app.inject({ method: "POST", url: "/v1/periodic-reminders", payload: input })).statusCode).toBe(401);
    const preview = (await f.request("POST", "/preview", input)).json();
    expect(f.engine.periodic.list()).toHaveLength(0);
    const a = await f.request("POST", "", input, "create");
    expect(a.statusCode).toBe(201);
    const rule = a.json().reminder;
    expect(rule.nextFireAt).toBe(preview.nextFireAt); expect(rule.summary).toBe(preview.summary);
    const retry = await f.request("POST", "", input, "create");
    expect(retry.json().reminder.id).toBe(rule.id);
    expect((await f.request("POST", "", { ...input, title: "another" }, "create")).statusCode).toBe(422);
    expect(f.engine.listTasks()).toEqual([]);
    expect(f.engine.exportBundle().periodicReminders).toHaveLength(1);
  });
  it("returns actionable field errors and supports one-call versioned edits and daily pause", async () => {
    const f = fixture();
    const invalid = await f.request("POST", "", { ...input, windows: [{ start: "09:00", end: "09:20" }] });
    expect(invalid.statusCode).toBe(400); expect(invalid.json().error.details[0].path).toContain("intervalMinutes");
    const rule = (await f.request("POST", "", input)).json().reminder;
    const edited = (await f.request("PATCH", `/${rule.id}`, { intervalMinutes: 60, weekdays: [6, 7], expectedVersion: 1 }, "edit")).json().reminder;
    expect(edited.weekdays).toEqual([6, 7]); expect(edited.version).toBe(2);
    expect((await f.request("PATCH", `/${rule.id}`, { title: "stale", expectedVersion: 1 })).statusCode).toBe(409);
    expect((await f.request("POST", `/${rule.id}/action`, { action: "pause_today", expectedVersion: 2 })).json().reminder.state).toBe("paused_today");
    expect((await f.request("GET", "?q=活动")).json().reminders).toHaveLength(1);
  });
  it("separates delivery claim/receipt from completion and rejects late/stale requests", async () => {
    const f = fixture();
    const rule = (await f.request("POST", "", { ...input, mode: "after_completion" })).json().reminder;
    f.clock.set("2026-09-07T01:30:00Z"); await f.engine.periodic.tick(f.notifier);
    const occurrence = f.engine.periodic.get(rule.id).currentOccurrence!;
    const claim = { occurrenceId: occurrence.id, round: 1, token: "app" };
    expect((await f.request("POST", `/${rule.id}/claim`, claim)).statusCode).toBe(200);
    expect((await f.request("POST", `/${rule.id}/receipt`, { ...claim, displayed: true })).json().reminder.currentOccurrence.result).toBe("pending");
    f.clock.advance(720_000);
    const done = { action: "complete", occurrenceId: occurrence.id, round: 1, expectedVersion: 1 };
    const first = await f.request("POST", `/${rule.id}/action`, done, "done");
    expect(first.json().reminder.nextFireAt).toBe("2026-09-07T02:12:00.000Z");
    expect((await f.request("POST", `/${rule.id}/action`, done, "done")).json()).toEqual(first.json());
    expect((await f.request("POST", `/${rule.id}/receipt`, { ...claim, displayed: true })).statusCode).toBe(409);
  });
  it("habit is the default, follow-up is configurable, and the away route restarts the timer", async () => {
    const f = fixture();
    const rule = (await f.request("POST", "", input)).json().reminder;
    expect(rule).toMatchObject({ mode: "after_completion", followUpMinutes: 10 });
    expect((await f.request("POST", "", { ...input, followUpMinutes: 200 })).statusCode).toBe(400);
    expect((await f.request("PATCH", `/${rule.id}`, { followUpMinutes: 0, expectedVersion: 1 })).json().reminder.followUpMinutes).toBe(0);
    expect((await app.inject({ method: "POST", url: "/v1/periodic-reminders/away", payload: { minutes: 5 } })).statusCode).toBe(401);
    expect((await f.request("POST", "/away", { minutes: 1 })).statusCode).toBe(400);
    f.clock.set("2026-09-07T01:50:00Z");
    const away = await f.request("POST", "/away", { minutes: 6 });
    expect(away.statusCode).toBe(200);
    expect(away.json()).toEqual({ reset: [rule.id] });
    expect(f.engine.periodic.get(rule.id).nextFireAt).toBe("2026-09-07T02:20:00.000Z");
  });
});
