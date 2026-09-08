import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { type MoveTaskInput, type Task } from "@todocue/shared";
import { TaskEngine } from "../src/engine.js";
import { migrations, openDatabase } from "../src/db.js";
import { FakeClock } from "../src/time.js";
import { makeEngine } from "./helpers.js";

const handles: Database.Database[] = [];
const dirs: string[] = [];
function setup() { const env = makeEngine(); handles.push(env.db); return env; }
afterEach(() => { handles.splice(0).forEach(db => { if (db.open) db.close(); }); dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });
function move(engine: TaskEngine, task: Task, input: Partial<MoveTaskInput> = {}) {
  return engine.moveTask(task.id, {
    view: "all", sourceGroup: task.project ?? "", targetGroup: task.project ?? "", beforeId: null,
    expectedVersion: task.version, expectedRevision: engine.ordering().revision, ...input,
  });
}
const ids = (tasks: Task[]) => tasks.map(t => t.id);

describe("persistent list ordering", () => {
  it("moves low importance above high without changing importance; reset and undo restore exact order", () => {
    const { engine } = setup();
    const high = engine.createTask({ title: "high", priority: "high" }).task;
    const low = engine.createTask({ title: "low", priority: "low" }).task;
    move(engine, low, { beforeId: high.id });
    expect(ids(engine.listTasks())).toEqual([low.id, high.id]);
    expect(engine.getTask(low.id).priority).toBe("low");
    const reset = engine.resetOrder({ view: "all", group: "", expectedRevision: engine.ordering().revision });
    expect(ids(engine.listTasks())).toEqual([high.id, low.id]);
    engine.undoOrder({ token: reset.undoToken, expectedRevision: reset.ordering.revision });
    expect(ids(engine.listTasks())).toEqual([low.id, high.id]);
  });

  it("keeps today, upcoming and project orders independent, and appends new tasks in manual groups", () => {
    const { engine } = setup();
    const a = engine.createTask({ title: "a", scheduledDate: engine.today(), priority: "high" }).task;
    const b = engine.createTask({ title: "b", scheduledDate: engine.today() }).task;
    move(engine, b, { beforeId: a.id });
    expect(engine.todayView().items.map(i => i.task.id)).toEqual([a.id, b.id]);
    const group = `${engine.today()}:scheduled`;
    move(engine, b, { view: "today", sourceGroup: group, targetGroup: group, beforeId: a.id });
    expect(engine.nextView().next?.task.id).toBe(b.id);
    const c = engine.createTask({ title: "c", scheduledDate: engine.today(), priority: "high" }).task;
    expect(engine.todayView().items.map(i => i.task.id)).toEqual([b.id, a.id, c.id]);
    expect(ids(engine.listTasks())).toEqual([b.id, a.id, c.id]);
    const futureA = engine.createTask({ title: "future a", scheduledDate: "2026-09-09", priority: "high" }).task;
    const futureB = engine.createTask({ title: "future b", scheduledDate: "2026-09-09" }).task;
    move(engine, futureB, { view: "upcoming", sourceGroup: "2026-09-09", targetGroup: "2026-09-09", beforeId: futureA.id });
    expect(ids(engine.listTasks({ view: "upcoming", from: "2026-09-09" }))).toEqual([futureB.id, futureA.id]);
    expect(ids(engine.listTasks({ from: "2026-09-09" }))).toEqual([futureA.id, futureB.id]);
  });

  it("moves across projects and into empty ungrouped; undo restores project and both group orders", () => {
    const { engine } = setup();
    const a = engine.createTask({ title: "a", project: "A" }).task;
    const b = engine.createTask({ title: "b", project: "B" }).task;
    move(engine, a, { targetGroup: "B", beforeId: b.id });
    const current = engine.getTask(a.id);
    const previous = engine.ordering().groups;
    const result = move(engine, current, { targetGroup: "" });
    expect(engine.getTask(a.id).project).toBeNull();
    engine.undoOrder({ token: result.undoToken, expectedRevision: result.ordering.revision });
    expect(engine.getTask(a.id).project).toBe("B");
    expect(engine.ordering().groups).toEqual(previous);
    expect(ids(engine.listTasks({ project: "B" }))).toEqual([a.id, b.id]);
  });

  it("rolls back fields, ordering, version, reminders and events when the target disappears", () => {
    const { engine } = setup();
    const a = engine.createTask({ title: "a", project: "A", reminderAt: "2026-09-10T10:00" }).task;
    const before = engine.exportBundle();
    const events: unknown[] = []; engine.onEvent(e => events.push(e));
    expect(() => move(engine, a, { targetGroup: "B", beforeId: "missing" })).toThrow(/目标任务/);
    expect(engine.exportBundle()).toEqual(before);
    expect(events).toEqual([]);
  });

  it("rejects stale snapshots and undo after any concurrent task edit", () => {
    const { engine } = setup();
    const a = engine.createTask({ title: "a" }).task;
    const b = engine.createTask({ title: "b" }).task;
    const revision = engine.ordering().revision;
    const result = move(engine, b, { beforeId: a.id });
    expect(() => move(engine, a, { expectedRevision: revision })).toThrow(/version conflict/);
    engine.updateTask(a.id, { notes: "external change" });
    expect(() => engine.undoOrder({ token: result.undoToken, expectedRevision: result.ordering.revision })).toThrow(/version conflict/);
    expect(engine.getTask(a.id).notes).toBe("external change");
  });

  it("rejects completed tasks and Today cross-section moves without changing deadlines", () => {
    const { engine } = setup();
    const a = engine.createTask({ title: "late", dueDate: "2026-09-06" }).task;
    expect(() => move(engine, a, { view: "today", sourceGroup: "2026-09-07:overdue", targetGroup: "2026-09-07:scheduled" })).toThrow(/截止日期/);
    expect(engine.getTask(a.id)).toEqual(a);
    const done = engine.completeTask(a.id);
    expect(() => move(engine, done)).toThrow(/未完成/);
  });

  it("keeps Today section precedence and excludes future start times from Next", () => {
    const { engine } = setup();
    const scheduled = engine.createTask({ title: "planned", scheduledDate: engine.today() }).task;
    const later = engine.createTask({ title: "later", scheduledAt: "2026-09-07T16:00" }).task;
    const late = engine.createTask({ title: "overdue", dueDate: "2026-09-06" }).task;
    const group = "2026-09-07:scheduled";
    move(engine, later, { view: "today", sourceGroup: group, targetGroup: group, beforeId: scheduled.id });
    expect(engine.todayView().items.map(i => i.task.id)).toEqual([late.id, later.id, scheduled.id]);
    expect(engine.nextView().candidates.map(i => i.task.id)).toEqual([late.id, scheduled.id]);
  });

  it("invalidates date-section drop targets when midnight passes", () => {
    const { engine, clock } = setup();
    const a = engine.createTask({ title: "a", scheduledDate: engine.today() }).task;
    clock.advance(24 * 3600_000);
    expect(() => move(engine, a, { view: "today", sourceGroup: "2026-09-07:scheduled", targetGroup: "2026-09-07:scheduled" })).toThrow(/分组已改变/);
  });

  it("reschedules using the task timezone across DST, preserving deadline, reminder and recurrence identity", () => {
    const { engine } = setup();
    const created = engine.createTask({ title: "daily", repeat: { kind: "daily" }, timezone: "America/New_York", startDate: "2026-09-08", scheduledTime: "09:15" });
    const a = engine.updateTask(created.task.id, { reminderAt: "2026-09-08T08:00", dueDate: "2026-12-01" });
    const series = engine.getSeries(a.seriesId!);
    const result = move(engine, a, { view: "upcoming", sourceGroup: "2026-09-08", targetGroup: "2026-11-02" });
    const moved = engine.getTask(a.id);
    expect(moved.scheduledAt).toBe("2026-11-02T14:15:00.000Z");
    expect(moved.reminderAt).toBe(a.reminderAt);
    expect(moved.dueDate).toBe(a.dueDate);
    expect(moved.occurrenceDate).toBe(a.occurrenceDate);
    expect(engine.getSeries(a.seriesId!)).toEqual(series);
    engine.undoOrder({ token: result.undoToken, expectedRevision: result.ordering.revision });
    expect(engine.getTask(a.id).scheduledAt).toBe(a.scheduledAt);
  });

  it("requires explicit deadline confirmation atomically; a due-only task gets a plan", () => {
    const { engine } = setup();
    const a = engine.createTask({ title: "deadline", dueDate: "2026-09-08", reminderAt: "2026-09-08T09:00" }).task;
    const revision = engine.ordering().revision;
    const options = { view: "upcoming" as const, sourceGroup: "2026-09-08", targetGroup: "2026-09-10" };
    expect(() => move(engine, a, options)).toThrow(/请确认/);
    expect(engine.getTask(a.id)).toEqual(a);
    expect(engine.ordering().revision).toBe(revision);
    move(engine, a, { ...options, allowPastDeadline: true });
    const moved = engine.getTask(a.id);
    expect(moved.scheduledDate).toBe("2026-09-10");
    expect(moved.dueDate).toBe(a.dueDate);
    expect(moved.reminderAt).toBe(a.reminderAt);
    expect(ids(engine.board().upcoming)).toContain(a.id);
  });

  it("handles same-day exact deadline conflicts and rejects impossible dates", () => {
    const { engine } = setup();
    const a = engine.createTask({ title: "time", scheduledAt: "2026-09-08T15:00", dueAt: "2026-09-09T14:00" }).task;
    const options = { view: "upcoming" as const, sourceGroup: "2026-09-08", targetGroup: "2026-09-09" };
    expect(() => move(engine, a, options)).toThrow(/请确认/);
    expect(() => move(engine, a, { ...options, targetGroup: "2026-02-30" })).toThrow(/invalid/);
    expect(engine.getTask(a.id)).toEqual(a);
  });

  it("returns future plans with deadlines today in both lenses; unscheduled remains a Next fallback", () => {
    const { engine } = setup();
    const a = engine.createTask({ title: "both", scheduledDate: "2026-09-08", dueDate: "2026-09-07" }).task;
    const b = engine.createTask({ title: "fallback" }).task;
    const board = engine.board();
    expect(ids(board.upcoming)).toContain(a.id);
    expect(board.today.items.map(i => i.task.id)).toContain(a.id);
    expect(board.next.next?.task.id).toBe(b.id);
  });

  it("migrates populated v2 without rewriting any task, series, reminder or attachment; order survives reopen", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todocue-order-migration-")); dirs.push(dir);
    const file = path.join(dir, "fixture.sqlite");
    const legacy = new Database(file);
    migrations.slice(0, 2).forEach(m => m.up(legacy));
    legacy.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT); INSERT INTO schema_migrations VALUES(1,'initial','2026-01-01'),(2,'attachments','2026-01-01'); INSERT INTO settings VALUES('timezone','Asia/Shanghai'); INSERT INTO tasks(id,title,timezone,created_at,updated_at) VALUES('a','真实数据模拟','Asia/Shanghai','2026-01-01','2026-01-01'),('b','另一项','Asia/Shanghai','2026-01-02','2026-01-02'); INSERT INTO attachments VALUES('file','a','hello.txt','text/plain',5,'hash',X'68656c6c6f','2026-01-01'); INSERT INTO reminders(id,task_id,fire_at,status,created_at,updated_at) VALUES('r','a','2026-10-01','pending','2026-01-01','2026-01-01')");
    const tables = ["tasks", "series", "attachments", "reminders", "settings"];
    const rows = tables.map(table => legacy.prepare(`SELECT * FROM ${table}`).all());
    legacy.close();
    const opened = openDatabase({ path: file }); handles.push(opened.db);
    expect(opened.appliedMigrations).toEqual([3]);
    expect(opened.backupPath).toBeTruthy();
    tables.forEach((table, i) => expect(opened.db.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows[i]));
    const backup = new Database(opened.backupPath!, { readonly: true }); handles.push(backup);
    tables.forEach((table, i) => expect(backup.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows[i]));
    const clock = new FakeClock("2026-09-07T01:00:00Z");
    const engine = new TaskEngine({ db: opened.db, clock });
    const result = move(engine, engine.getTask("b"), { beforeId: "a" });
    opened.db.close();
    const reopened = openDatabase({ path: file }); handles.push(reopened.db);
    expect(reopened.appliedMigrations).toEqual([]);
    const restored = new TaskEngine({ db: reopened.db, clock });
    expect(ids(restored.listTasks())).toEqual(["b", "a"]);
    restored.undoOrder({ token: result.undoToken, expectedRevision: result.ordering.revision });
    expect(ids(restored.listTasks())).toEqual(["a", "b"]);
  });
});
