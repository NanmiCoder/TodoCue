import { describe, expect, it } from "vitest";
import { makeEngine } from "../../../packages/engine/test/helpers.js";
import { afterSave, draftPayload, newDraft } from "../src/drafts.js";
import { landsAfterDeadline, reschedule } from "../src/dates.js";
import { CueStack, LatestRequest, shouldCollapseQuickLook } from "../src/model.js";

describe("review failure scenarios", () => {
  it("outside clicks close pinned and editing quick looks, while reminder stacks remain", () => {
    for (const pinned of [true, false]) for (const editing of [true, false])
      expect(shouldCollapseQuickLook("outside", { expanded: true, pinned, editing })).toBe(true);
    expect(shouldCollapseQuickLook("outside", { expanded: false, pinned: false, editing: false })).toBe(false);
    expect(shouldCollapseQuickLook("leave", { expanded: true, pinned: false, editing: false })).toBe(true);
    expect(shouldCollapseQuickLook("leave", { expanded: true, pinned: true, editing: false })).toBe(false);
    expect(shouldCollapseQuickLook("leave", { expanded: true, pinned: false, editing: true })).toBe(false);
  });
  it("four simultaneous offers display three and leave the fourth for system delivery", async () => {
    const f = makeEngine({ tz: "UTC" });
    try {
      const rules = Array.from({ length: 4 }, (_, i) => f.engine.periodic.create({
        title: `Cue ${i}`, intervalMinutes: 1, windows: [{ start: "00:00", end: "23:59" }],
      }));
      f.clock.advance(60000);
      await f.scheduler.tick();
      const stack = new CueStack();
      const admitted = rules.filter(rule => stack.reserve(`periodic:${rule.id}`));
      expect(admitted).toHaveLength(3);
      // A task arriving during the async claim cannot displace an unacknowledged row.
      await Promise.all(admitted.map(async rule => {
        await Promise.resolve();
        const occurrence = f.engine.periodic.get(rule.id).currentOccurrence!;
        const claim = { occurrenceId: occurrence.id, round: occurrence.round, token: rule.id };
        const reminder = f.engine.periodic.claim(rule.id, claim);
        stack.receive({ key: `periodic:${rule.id}`, id: occurrence.id, title: rule.title, periodic: reminder, receivedAt: f.clock.now().getTime() });
        const task = f.engine.createTask({ title: "Task arrival" }).task;
        stack.receive({ key: `task:${task.id}`, id: task.id, title: task.title, task, receivedAt: f.clock.now().getTime() });
      }));
      expect(stack.shown().slice(0, 3).map(cue => cue.periodic?.id)).toEqual(admitted.map(rule => rule.id));
      for (const rule of admitted) {
        const occurrence = f.engine.periodic.get(rule.id).currentOccurrence!;
        f.engine.periodic.receipt(rule.id, { occurrenceId: occurrence.id, round: occurrence.round, token: rule.id, displayed: true });
        stack.release(`periodic:${rule.id}`);
      }
      f.clock.advance(3100);
      await f.scheduler.tick();
      expect(f.notifier.delivered.map(item => item.periodicId)).toEqual([rules[3]!.id]);
      expect(f.engine.periodic.get(rules[3]!.id).currentOccurrence).toMatchObject({ delivery: "submitted", result: "pending" });
    } finally { f.db.close(); }
  });
  it("releases a cancelled reservation without claiming or consuming an offer", () => {
    const stack = new CueStack();
    for (const key of ["a", "b", "c"]) expect(stack.reserve(key)).toBe(true);
    expect(stack.reserve("d")).toBe(false);
    expect(stack.reserve("a")).toBe(false);
    stack.release("b");
    expect(stack.reserve("d")).toBe(true);
  });
  it.each([false, true])("removes an upload deleted during %s-save, including identical names and bytes", existing => {
    const f = makeEngine();
    try {
      const file = { name: "same.txt", mediaType: "text/plain", dataBase64: "YWJj" };
      const task = existing ? f.engine.createTask({ title: "Draft", attachments: [file] }).task : undefined;
      const submitted = newDraft(task, "2026-09-07", "Draft");
      submitted.uploads = [{ ...file }, { ...file }];
      const latest = { ...submitted, key: crypto.randomUUID(), uploads: [submitted.uploads[0]!] };
      const payload = draftPayload(submitted);
      const saved = task ? f.engine.updateTask(task.id, payload) : f.engine.createTask(payload).task;
      const retained = afterSave(latest, submitted, saved)!;
      expect(retained.removed).toEqual([saved.attachments.at(-1)!.id]);
      const next = f.engine.updateTask(saved.id, draftPayload(retained));
      expect(next.attachments.map(item => item.id)).toEqual(saved.attachments.slice(0, -1).map(item => item.id));
      expect(next.attachments).toHaveLength(existing ? 2 : 1);
    } finally { f.db.close(); }
  });
  it("a late history snapshot cannot restore a task reopened by a newer action", async () => {
    const f = makeEngine();
    try {
      const a = f.engine.createTask({ title: "A" }).task, b = f.engine.createTask({ title: "B" }).task;
      f.engine.completeTask(a.id, {}); f.engine.completeTask(b.id, {});
      const requests = new LatestRequest();
      let shown = f.engine.listTasks({ status: "done" });
      f.engine.reopenTask(a.id, {});
      const stale = f.engine.listTasks({ status: "done" });
      let release!: (tasks: typeof shown) => void;
      const first = requests.run(() => new Promise<typeof shown>(resolve => { release = resolve; }), tasks => { shown = tasks; }, error => { throw error; });
      f.engine.reopenTask(b.id, {});
      await requests.run(async () => f.engine.listTasks({ status: "done" }), tasks => { shown = tasks; }, error => { throw error; });
      release(stale); await first;
      expect(shown).toEqual([]);
      let failed = false;
      let reject!: (error: Error) => void;
      const cancelled = requests.run(() => new Promise<never>((_, fail) => { reject = fail; }), () => {}, () => { failed = true; });
      requests.invalidate(); reject(new Error("Late failure after leaving history")); await cancelled;
      expect(failed).toBe(false);
    } finally { f.db.close(); }
  });
  it.each([
    ["UTC", "2026-10-20T18:00:00Z", "2026-10-21T17:00:00Z", "2026-10-21"],
    ["Asia/Shanghai", "2026-10-20T10:00:00Z", "2026-10-21T09:00:00Z", "2026-10-21"],
    ["America/New_York", "2026-03-07T07:30:00Z", "2026-03-08T07:00:00Z", "2026-03-08"],
  ])("calendar compares the moved instant with a same-day deadline in %s", (timezone, scheduledAt, dueAt, day) => {
    const f = makeEngine({ tz: timezone });
    try {
      const task = f.engine.createTask({ title: "Timed move", scheduledAt, dueAt }).task;
      expect(landsAfterDeadline(task, day)).toBe(true);
      const payload = reschedule(task, day);
      const moved = f.engine.updateTask(task.id, payload);
      expect(Date.parse(moved.scheduledAt!)).toBeGreaterThan(Date.parse(dueAt));
      expect(moved.dueAt).toBe(task.dueAt);
      expect(landsAfterDeadline({ ...task, dueAt: payload.scheduledAt! }, day)).toBe(false);
      expect(landsAfterDeadline({ ...task, dueAt: null, dueDate: day }, day)).toBe(false);
      expect(landsAfterDeadline({ ...task, scheduledAt: null, scheduledDate: day }, day)).toBe(false);
    } finally { f.db.close(); }
  });
});
