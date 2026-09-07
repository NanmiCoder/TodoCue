import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type RuntimeEvent } from "@todocue/shared";
import { migrations, openDatabase } from "../src/db.js";
import { TaskEngine } from "../src/engine.js";
import { makeEngine } from "./helpers.js";

const file = (name = "图片.png", text = "image bytes") => ({ name, mediaType: "image/png", dataBase64: Buffer.from(text).toString("base64") });
const handles: Database.Database[] = [];
const dirs: string[] = [];
function setup() { const env = makeEngine(); handles.push(env.db); return env; }
afterEach(() => { handles.splice(0).forEach((db) => db.close()); dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })); });

describe("attachment transactions and persistence", () => {
  it("copies multiple binary files, preserves order/checksums, and exposes metadata across every task view", () => {
    const { engine } = setup();
    const binary = Buffer.from([0, 255, 1, 2, 0, 128]);
    const { task } = engine.createTask({ title: "图文记录", scheduledDate: engine.today(), attachments: [file(), { name: "文件.bin", dataBase64: binary.toString("base64") }] });
    expect(task.version).toBe(1);
    expect(task.attachments.map((a) => a.name)).toEqual(["图片.png", "文件.bin"]);
    expect(engine.attachments.get(task.id, task.attachments[1]!.id).data).toEqual(binary);
    expect(task.attachments[1]).toMatchObject({ size: 6, mediaType: "application/octet-stream" });
    expect(task.attachments[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(engine.listTasks()[0]!.attachments).toEqual(task.attachments);
    expect(engine.todayView().items[0]!.task.attachments).toEqual(task.attachments);
    expect(engine.nextView().next!.task.attachments).toEqual(task.attachments);
    expect(engine.completeTask(task.id).attachments).toEqual(task.attachments);
    expect(engine.todayView().completed[0]!.attachments).toEqual(task.attachments);
    expect(engine.exportBundle().attachments[1]!.dataBase64).toBe(binary.toString("base64"));
  });

  it("infers common image MIME types for raw API clients while preserving explicit types", () => {
    const { engine } = setup();
    const task = engine.createTask({ title: "images", attachments: [
      { name: "图.PNG", dataBase64: "AA==" }, { name: "scan.pdf", dataBase64: "" },
      { name: "custom.png", mediaType: "application/octet-stream", dataBase64: "" },
    ] }).task;
    expect(task.attachments.map((a) => a.mediaType)).toEqual(["image/png", "application/pdf", "application/octet-stream"]);
  });

  it.each(["../secret", "a/b", "a\\b", "x\n.png", ".", "..", "", " "])("rejects unsafe filename %j without creating a task", (name) => {
    const { engine } = setup();
    expect(() => engine.createTask({ title: "invalid", attachments: [file(name)] })).toThrow();
    expect(engine.counts().tasks).toBe(0);
  });

  it.each(["a", "a===", "!!!!", "YQ", "YQ==\n", "YR=="])("rejects noncanonical base64 %j", (dataBase64) => {
    const { engine } = setup();
    expect(() => engine.createTask({ title: "invalid", attachments: [{ name: "a", dataBase64 }] })).toThrow();
    expect(engine.counts().tasks).toBe(0);
  });

  it("rolls back a whole recurring create including events if its last attachment is invalid", () => {
    const { engine } = setup();
    const events: RuntimeEvent[] = [];
    engine.onEvent((e) => events.push(e));
    expect(() => engine.createTask({ title: "bad", repeat: { kind: "daily" }, attachments: [file(), { name: "bad", dataBase64: "!" }] })).toThrow();
    expect(engine.counts()).toMatchObject({ tasks: 0, series: 0 });
    expect(engine.exportBundle().attachments).toEqual([]);
    expect(events).toEqual([]);
  });

  it("attaches to the first recurrence only, with later instances remaining independent", () => {
    const { engine } = setup();
    const { task, series } = engine.createTask({ title: "repeat", repeat: { kind: "daily" }, attachments: [file()] });
    const tasks = engine.getSeriesTasks(series!.id);
    expect(tasks.find((t) => t.id === task.id)!.attachments).toHaveLength(1);
    expect(tasks.filter((t) => t.id !== task.id).every((t) => t.attachments.length === 0)).toBe(true);
  });

  it("atomically replaces files with text edits, rolls back missing ids, and rejects stale versions", () => {
    const { engine } = setup();
    const { task } = engine.createTask({ title: "original", attachments: [file()] });
    const id = task.attachments[0]!.id;
    expect(() => engine.updateTask(task.id, { title: "oops", removeAttachmentIds: [id, "missing"] })).toThrow();
    expect(engine.getTask(task.id)).toEqual(task);
    const updated = engine.updateTask(task.id, { title: "replaced", removeAttachmentIds: [id], addAttachments: [file("new.txt")], expectedVersion: 1 });
    expect(updated.version).toBe(2);
    expect(updated.attachments.map((a) => a.name)).toEqual(["new.txt"]);
    expect(() => engine.updateTask(task.id, { addAttachments: [file()], expectedVersion: 1 })).toThrow(/version/i);
    expect(() => engine.attachments.get(task.id, id)).toThrow();
    const other = engine.createTask({ title: "other" }).task;
    expect(() => engine.attachments.get(other.id, updated.attachments[0]!.id)).toThrow();
    expect(() => engine.updateTask(other.id, { removeAttachmentIds: [updated.attachments[0]!.id] })).toThrow();
  });

  it("enforces count, decoded per-file and aggregate limits without partial writes", () => {
    const { engine } = setup();
    const { task } = engine.createTask({ title: "count", attachments: Array.from({ length: MAX_ATTACHMENTS }, () => file()) });
    expect(() => engine.updateTask(task.id, { addAttachments: [file()] })).toThrow(/20/);
    expect(engine.getTask(task.id).version).toBe(1);
    const over = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64");
    expect(() => engine.createTask({ title: "over", attachments: [{ name: "big", dataBase64: over }] })).toThrow(/10 MiB/);
    const max = { name: "max", dataBase64: Buffer.alloc(MAX_ATTACHMENT_BYTES).toString("base64") };
    const large = engine.createTask({ title: "large", attachments: [max, max, max] }).task;
    expect(large.attachments).toHaveLength(3);
    expect(() => engine.updateTask(large.id, { addAttachments: [file()] })).toThrow(/30 MiB/);
    expect(engine.getTask(large.id).attachments).toHaveLength(3);
  });

  it("backs up schema v1 before migration and retains bytes after database reopen", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todocue-migration-")); dirs.push(dir);
    const database = path.join(dir, "tasks.sqlite");
    const old = new Database(database);
    migrations[0]!.up(old);
    old.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT); INSERT INTO schema_migrations VALUES(1,'initial','2026-01-01'); INSERT INTO settings VALUES('timezone','Asia/Shanghai')");
    old.exec("INSERT INTO tasks(id,title,timezone,created_at,updated_at) VALUES('old-task','keep me','Asia/Shanghai','2026-01-01','2026-01-01')");
    old.close();
    const opened = openDatabase({ path: database });
    expect(opened.schemaVersion).toBe(2);
    expect(fs.existsSync(opened.backupPath!)).toBe(true);
    const backup = new Database(opened.backupPath!, { readonly: true });
    expect(backup.prepare("SELECT title FROM tasks").get()).toEqual({ title: "keep me" }); backup.close();
    const engine = new TaskEngine({ db: opened.db });
    expect(engine.getTask("old-task").attachments).toEqual([]);
    const task = engine.updateTask("old-task", { addAttachments: [file()] });
    opened.db.close();
    const reopened = openDatabase({ path: database }); handles.push(reopened.db);
    expect(reopened.appliedMigrations).toEqual([]);
    const restored = new TaskEngine({ db: reopened.db });
    expect(restored.getTask(task.id)).toEqual(task);
    expect(restored.attachments.get(task.id, task.attachments[0]!.id).data.toString()).toBe("image bytes");
  });
});

describe("reminder Cue delivery", () => {
  it("emits once despite notification denial, retries and scheduler recreation; snooze creates a new Cue", async () => {
    const { engine, clock, notifier, scheduler } = setup();
    const cues: RuntimeEvent[] = [];
    engine.onEvent((e) => { if (e.type === "reminder.fired") cues.push(e); });
    const task = engine.createTask({ title: "Cue", reminderAt: "2026-09-07T09:01" }).task;
    clock.advance(61_000); notifier.failNext = "notifications denied";
    await scheduler.tick();
    expect(cues).toHaveLength(1);
    expect(cues[0]!.related).toMatchObject({ taskId: task.id, count: "1", late: "false", fireAt: task.reminderAt });
    clock.advance(31_000); await scheduler.tick();
    expect(cues).toHaveLength(1);
    const reopened = new TaskEngine({ db: engine.db, clock });
    const reminder = engine.listReminders({ taskId: task.id })[0]!;
    reopened.onEvent((e) => { if (e.type === "reminder.fired") cues.push(e); });
    reopened.emitReminderCue([reminder.id], false);
    expect(cues).toHaveLength(1);
    engine.snoozeTask(task.id, { minutes: 1 }); clock.advance(60_000); await scheduler.tick();
    expect(cues).toHaveLength(2);
    expect(cues[1]!.id).not.toBe(cues[0]!.id);
  });

  it("does not Cue cancelled/rescheduled tasks and groups multiple missed reminders", async () => {
    const { engine, clock, scheduler } = setup();
    const cues: RuntimeEvent[] = []; engine.onEvent((e) => { if (e.type === "reminder.fired") cues.push(e); });
    const cancelled = engine.createTask({ title: "cancel", reminderAt: "2026-09-07T09:01" }).task;
    engine.cancelTask(cancelled.id);
    const later = engine.createTask({ title: "later", reminderAt: "2026-09-07T09:01" }).task;
    engine.updateTask(later.id, { reminderAt: "2026-09-08T09:01" });
    engine.createTask({ title: "missed 1", reminderAt: "2026-09-07T09:01" });
    engine.createTask({ title: "missed 2", reminderAt: "2026-09-07T09:02" });
    clock.advance(3600_000); await scheduler.tick(true);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.related).toMatchObject({ count: "2", late: "true" });
  });
});
