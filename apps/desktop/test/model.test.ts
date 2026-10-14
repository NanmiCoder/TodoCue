import { describe, it, expect } from "vitest";
import {
  CueStack,
  canPresentPeriodic,
  periodicActive,
  taskCue,
  latestBoard,
} from "../src/model.js";
import { afterSave, newDraft, draftPayload } from "../src/drafts.js";
import { reschedule, ghostDates, planDate, dayLabel } from "../src/dates.js";
import { projectGroups } from "../src/drag.js";
import { makeEngine } from "../../../packages/engine/test/helpers.js";

describe("desktop behavior against real runtime state", () => {
  it("groups deadline-only upcoming tasks by their deadline without crashing", () => {
    const fixture = makeEngine();
    try {
      const task = fixture.engine.createTask({
        title: "Deadline only",
        dueDate: "2026-09-08",
      }).task;
      expect(fixture.engine.board().upcoming.map((task) => task.id)).toContain(
        task.id,
      );
      expect(planDate(task)).toBe("2026-09-08");
      expect(dayLabel(planDate(task)!, "zh-CN")).toBeTruthy();
      expect(dayLabel("", "en")).toBe("Unscheduled");
    } finally {
      fixture.db.close();
    }
  });
  it("keeps a task's precise plan/deadline/reminder when editing its title", () => {
    const fixture = makeEngine();
    try {
      const task = fixture.engine.createTask({
        title: "Before",
        scheduledAt: "2026-09-07T01:30:01.123Z",
        dueAt: "2026-09-07T04:00:00.456Z",
        reminderAt: "2026-09-07T01:10:00.789Z",
      }).task;
      const draft = newDraft(task);
      draft.title = "After";
      const payload = draftPayload(draft);
      expect(payload).toMatchObject({
        scheduledAt: task.scheduledAt,
        dueAt: task.dueAt,
        reminderAt: task.reminderAt,
        expectedVersion: task.version,
      });
    } finally {
      fixture.db.close();
    }
  });
  it("keeps edits made during a save and rebases their next write onto the saved version", () => {
    const fixture = makeEngine();
    try {
      const task = fixture.engine.createTask({ title: "Before" }).task;
      const submitted = newDraft(task);
      submitted.notes = "Submitted";
      const upload = {
        name: "first.txt",
        dataBase64: "YWJj",
        mediaType: "text/plain",
      };
      submitted.uploads = [upload];
      const latest = {
        ...submitted,
        key: crypto.randomUUID(),
        notes: "Typed during save",
        uploads: [upload, { ...upload, name: "later.txt" }],
      };
      const saved = fixture.engine.updateTask(task.id, draftPayload(submitted));
      const retained = afterSave(latest, submitted, saved)!;
      expect(retained.notes).toBe("Typed during save");
      expect(retained.original?.version).toBe(saved.version);
      expect(retained.uploads.map((file) => file.name)).toEqual(["later.txt"]);
      expect(draftPayload(retained)).toMatchObject({
        expectedVersion: saved.version,
        notes: "Typed during save",
      });
      expect(afterSave(submitted, submitted, saved)).toBeUndefined();
    } finally {
      fixture.db.close();
    }
  });
  it("calendar date moves keep the task's local clock, deadline and independent reminder", () => {
    const fixture = makeEngine({ tz: "America/New_York" });
    try {
      const task = fixture.engine.createTask({
        title: "Meeting",
        scheduledAt: "2026-09-07T13:30:00Z",
        dueDate: "2026-09-12",
        reminderAt: "2026-09-07T13:00:00Z",
      }).task;
      const result = fixture.engine.updateTask(
        task.id,
        reschedule(task, "2026-11-03"),
      );
      expect(result.scheduledAt).toBe("2026-11-03T14:30:00.000Z");
      expect(result.dueDate).toBe(task.dueDate);
      expect(result.reminderAt).toBe(task.reminderAt);
    } finally {
      fixture.db.close();
    }
  });
  it("SSE replays and reconnects do not inflate ×N after the five-minute replay window", () => {
    const stack = new CueStack();
    const cue = { id: "same", key: "periodic:p", title: "Move", receivedAt: 0 };
    stack.receive(cue, 0);
    stack.receive({ ...cue, title: "Updated" }, 300001);
    expect(stack.entries[0]).toMatchObject({ repeats: 1, title: "Updated" });
    stack.receive({ ...cue, id: "new-round" }, 300002);
    expect(stack.entries[0]?.repeats).toBe(2);
  });
  it("claims only actually renderable cards; overflow leaves the system channel available", () => {
    const stack = new CueStack();
    for (let i = 0; i < 20; i++)
      stack.receive(
        { key: `periodic:${i}`, id: `${i}`, title: "Cue", receivedAt: 0 },
        0,
      );
    expect(stack.canDisplay("periodic:20")).toBe(false);
    expect(stack.canDisplay("periodic:0")).toBe(true);
    expect(
      stack.receive(
        { key: "overflow", id: "overflow", title: "Overflow", receivedAt: 0 },
        0,
      ),
    ).toBe(false);
    const state = {
      enabled: true,
      expanded: false,
      hovered: false,
      foreground: true,
    };
    expect(canPresentPeriodic(state)).toBe(true);
    for (const field of ["expanded", "hovered"] as const)
      expect(canPresentPeriodic({ ...state, [field]: true })).toBe(false);
    expect(canPresentPeriodic({ ...state, foreground: false })).toBe(false);
  });
  it("hides dormant periodic rows and removes externally snoozed cards", async () => {
    const fixture = makeEngine();
    try {
      const rule = fixture.engine.periodic.create({
        title: "Water",
        intervalMinutes: 1,
        windows: [{ start: "09:00", end: "10:00" }],
        mode: "after_completion",
      });
      fixture.clock.advance(60000);
      await fixture.scheduler.tick();
      const offered = fixture.engine.periodic.get(rule.id);
      const occurrence = offered.currentOccurrence!;
      const claim = {
        occurrenceId: occurrence.id,
        round: occurrence.round,
        token: "token",
      };
      fixture.engine.periodic.claim(rule.id, claim);
      const displayed = fixture.engine.periodic.receipt(rule.id, {
        ...claim,
        displayed: true,
      });
      const stack = new CueStack();
      stack.receive({
        key: rule.id,
        id: occurrence.id,
        title: rule.title,
        periodic: displayed,
        receivedAt: fixture.clock.now().getTime(),
      });
      expect(periodicActive(displayed, new Date("2026-09-07T02:01:00Z"))).toBe(
        false,
      );
      const result = fixture.engine.periodic.action(rule.id, {
        action: "snooze",
        occurrenceId: occurrence.id,
        round: occurrence.round,
        minutes: 10,
      });
      if ("deleted" in result) throw new Error("Unexpected deletion");
      const snoozed = result;
      stack.sync([], [snoozed]);
      expect(stack.entries).toHaveLength(0);
    } finally {
      fixture.db.close();
    }
  });
  it("rejects stale task reminders and preserves a newer board revision", () => {
    const fixture = makeEngine();
    try {
      const task = fixture.engine.createTask({
        title: "Task",
        reminderAt: "2026-09-07T01:01:00Z",
      }).task;
      const event = {
        seq: 1,
        type: "reminder.fired" as const,
        at: "2026-09-07T01:01:00Z",
        id: "r",
        related: { taskId: task.id, fireAt: task.reminderAt! },
      };
      expect(taskCue(event, task, Date.parse(event.at))).not.toBeNull();
      expect(
        taskCue(event, { ...task, status: "done" }, Date.parse(event.at)),
      ).toBeNull();
      const before = fixture.engine.board();
      fixture.engine.updateTask(task.id, { title: "New" });
      const after = fixture.engine.board();
      expect(latestBoard(after, before)).toBe(after);
    } finally {
      fixture.db.close();
    }
  });
  it("drag projection changes only the preview, not task fields or group data", () => {
    const fixture = makeEngine();
    try {
      const task = fixture.engine.createTask({
        title: "Move",
        project: "Source",
      }).task;
      const groups = [
        { key: "Source", label: "Source", tasks: [task] },
        { key: "Target", label: "Target", tasks: [] },
      ];
      const projected = projectGroups(groups, {
        task,
        source: "Source",
        target: "Target",
        beforeId: null,
        x: 0,
        y: 0,
        width: 100,
        height: 40,
      });
      expect(projected[1]?.tasks[0]?.id).toBe(task.id);
      expect(task.project).toBe("Source");
      expect(groups[0]?.tasks).toHaveLength(1);
    } finally {
      fixture.db.close();
    }
  });
});
