import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryNotifier } from "@todocue/engine";
import { startRuntime, TodoCueClient, type RunningRuntime } from "../src/index.js";
import { silentLogger } from "../src/logger.js";
import type { RuntimeEvent } from "@todocue/shared";

let rt: RunningRuntime;
let client: TodoCueClient;
const file = { name: "设计.png", mediaType: "image/png", dataBase64: "AAECA/8=" };
beforeAll(async () => {
  rt = await startRuntime({ memory: true, notifier: new MemoryNotifier(), logger: silentLogger });
  client = new TodoCueClient({ baseUrl: rt.baseUrl, token: rt.token });
});
afterAll(async () => { await rt.stop(); });

describe("authenticated attachment API", () => {
  it("creates/downloads exact bytes, returns download headers and refuses unauthenticated/cross-task reads", async () => {
    const { task } = await client.createTask({ title: "图文", attachments: [file] });
    const attachment = task.attachments[0]!;
    const url = `${rt.baseUrl}/v1/tasks/${task.id}/attachments/${attachment.id}/content`;
    expect((await fetch(url)).status).toBe(401);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${rt.token}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(file.dataBase64);
    const other = (await client.createTask({ title: "other" })).task;
    await expect(client.getAttachment(other.id, attachment.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await client.listAttachments(task.id)).attachments).toEqual(task.attachments);
    expect((await client.getAttachment(task.id, attachment.id)).dataBase64).toBe(file.dataBase64);
  });

  it("replays create and batch uploads without duplicate attachments; versions protect competing edits", async () => {
    const created = await client.createTask({ title: "retry", attachments: [file] }, { idempotencyKey: "attachment-create" });
    expect(await client.createTask({ title: "retry", attachments: [file] }, { idempotencyKey: "attachment-create" })).toEqual(created);
    const body = { files: [file, { name: "document.pdf", dataBase64: "JVBERg==" }], expectedVersion: 1 };
    const added = await client.addAttachments(created.task.id, body, { idempotencyKey: "attachment-upload" });
    expect(await client.addAttachments(created.task.id, body, { idempotencyKey: "attachment-upload" })).toEqual(added);
    expect(added.task.attachments).toHaveLength(3);
    await expect(client.addAttachments(created.task.id, { files: [file] }, { idempotencyKey: "attachment-upload" })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    await expect(client.removeAttachment(created.task.id, added.task.attachments[0]!.id, { expectedVersion: 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    const removed = await client.removeAttachment(created.task.id, added.task.attachments[0]!.id, { expectedVersion: 2 });
    expect(removed.task.attachments).toHaveLength(2);
    expect(removed.task.version).toBe(3);
  });

  it("supports uploads beyond the old 1 MiB request limit, with validation before mutation", async () => {
    const large = { name: "large.bin", dataBase64: Buffer.alloc(2 * 1024 * 1024, 42).toString("base64") };
    const { task } = await client.createTask({ title: "large", attachments: [large] });
    expect(task.attachments[0]!.size).toBe(2 * 1024 * 1024);
    await expect(client.addAttachments(task.id, { files: [file, { name: "bad", dataBase64: "invalid" }] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await client.getTask(task.id)).task.attachments).toHaveLength(1);
    await expect(client.addAttachments(task.id, { files: [{ name: "bad", dataBase64: "", mediaType: "text/html\r\nX: evil" }] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("publishes attachment changes and real reminder cues over SSE", async () => {
    const events: RuntimeEvent[] = [];
    const controller = new AbortController();
    const stream = client.events((e) => events.push(e), { signal: controller.signal }).catch(() => {});
    try {
      await expect.poll(() => events.some((e) => e.type === "runtime.started")).toBe(true);
      const { task } = await client.createTask({ title: "Cue image", reminderAt: new Date(Date.now() - 1000).toISOString() });
      await client.addAttachments(task.id, { files: [file] });
      await rt.scheduler.tick();
      await expect.poll(() => events.some((e) => e.type === "reminder.fired" && e.related?.taskId === task.id)).toBe(true);
      expect(events.some((e) => e.type === "task.updated" && e.id === task.id)).toBe(true);
      expect(events.filter((e) => e.type === "reminder.fired" && e.related?.taskId === task.id)).toHaveLength(1);
    } finally { controller.abort(); await stream; }
  });
});
