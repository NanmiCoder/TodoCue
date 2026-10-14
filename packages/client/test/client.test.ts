import { describe, it, expect } from "vitest";
import { TodoCueClient, type Request } from "../src/index.js";
import { startRuntime } from "@todocue/server";
import { FakeClock, MemoryNotifier } from "@todocue/engine";
import { TodoCueError } from "@todocue/shared";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("portable client", () => {
  it("forwards versions/idempotency without a token or Node APIs in the renderer", async () => {
    let captured: Request | undefined;
    const client = new TodoCueClient({ transport: { async request(input) { captured = input; return { status: 200, body: { task: { id: "t_x" } } }; } } });
    await client.completeTask("t_x", { expectedVersion: 7 }, { idempotencyKey: "finish-once" });
    expect(captured).toEqual({ method: "POST", path: "/tasks/t_x/complete", body: { expectedVersion: 7 }, idempotencyKey: "finish-once" });
    expect(captured).not.toHaveProperty("token");
  });
  it("retains conflict code and details from the API", async () => {
    const client = new TodoCueClient({ transport: { async request() { return { status: 409, body: { error: { code: "VERSION_CONFLICT", message: "Changed", details: { actual: 3 } } } }; } } });
    await expect(client.board()).rejects.toMatchObject({ code: "VERSION_CONFLICT", details: { actual: 3 } });
  });
  it("works with the real runtime: SSE, completion, stale writes and notch delivery receipt", async () => {
    const clock = new FakeClock("2026-10-13T01:00:00Z");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "todocue-client-"));
    const runtime = await startRuntime({ home, memory: true, clock, notifier: new MemoryNotifier(), tickMs: 60000 });
    const client = new TodoCueClient({ baseUrl: runtime.baseUrl, token: runtime.token });
    const abort = new AbortController(); const events: string[] = [];
    let started!: () => void; const connected = new Promise<void>(resolve => { started = resolve; });
    const stream = client.events(event => { events.push(event.type); if (event.type === "runtime.started") started(); }, { signal: abort.signal }).catch(error => { if (!abort.signal.aborted) throw error; });
    try {
      await connected;
      const { today } = await client.context();
      const { task } = await client.createTask({ title: "Native parity", scheduledDate: today }, { idempotencyKey: "create-once" });
      expect((await client.board()).today.remaining).toBe(1);
      await client.completeTask(task.id, { expectedVersion: task.version });
      expect((await client.board()).today.completed[0]?.id).toBe(task.id);
      await expect(client.updateTask(task.id, { title: "Stale", expectedVersion: task.version })).rejects.toBeInstanceOf(TodoCueError);
      const { reminder } = await client.createPeriodicReminder({ title: "Move", intervalMinutes: 1, windows: [{ start: "09:00", end: "10:00" }], timezone: "Asia/Shanghai" });
      clock.advance(60000); await runtime.engine.periodic.tick(runtime.notifier);
      const offered = (await client.getPeriodicReminder(reminder.id)).reminder.currentOccurrence!;
      const claim = { occurrenceId: offered.id, round: offered.round, token: "desktop-claim" };
      await client.claimPeriodic(reminder.id, claim);
      const displayed = await client.receiptPeriodic(reminder.id, { ...claim, displayed: true });
      expect(displayed.reminder.currentOccurrence?.delivery).toBe("displayed");
      expect(events).toContain("task.created");
    } finally { abort.abort(); await stream; await runtime.stop(); fs.rmSync(home, { recursive: true, force: true }); }
  });
});
