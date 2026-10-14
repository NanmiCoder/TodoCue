import { describe, expect, it } from "vitest";
import { makeEngine } from "../../../packages/engine/test/helpers.js";
import { CueStack, visibleCues, type Cue } from "../src/model.js";

describe("featured reminder presentation preserves resting rows and periodic admission", () => {
  const cues = (): Cue[] => Array.from({ length: 5 }, (_, index) => ({
    key: `task:${index}`, id: `event:${index}`, title: `Task ${index}`, receivedAt: 0, repeats: 1,
  }));

  it("shows the fourth featured arrival without moving the three resting reminders", () => {
    const all = cues();
    const shown = visibleCues(all, all[3]!.key);
    expect(shown.map(cue => cue.key)).toEqual(["task:0", "task:1", "task:2", "task:3"]);
    expect(shown.slice(0, 3)).toEqual(all.slice(0, 3));
    expect(all.map(cue => cue.key)).toEqual(["task:0", "task:1", "task:2", "task:3", "task:4"]);
    expect(all.length - shown.length).toBe(1);
    expect(visibleCues(all, null).map(cue => cue.key)).toEqual(["task:0", "task:1", "task:2"]);
  });

  it("does not duplicate a featured row already in the resting three or invent a missing one", () => {
    const all = cues();
    expect(visibleCues(all, all[1]!.key)).toEqual(all.slice(0, 3));
    expect(visibleCues(all, "task:removed")).toEqual(all.slice(0, 3));
    expect(visibleCues(all.slice(0, 1), all[0]!.key)).toEqual(all.slice(0, 1));
    expect(visibleCues([], null)).toEqual([]);
  });

  it("keeps three unacknowledged periodic reservations visible when a fourth featured task arrives", () => {
    const fixture = makeEngine({ tz: "UTC", now: "2026-10-14T08:00:00.000Z" });
    try {
      const stack = new CueStack();
      const periodicKeys = ["periodic:a", "periodic:b", "periodic:c"];
      for (const key of periodicKeys) expect(stack.reserve(key)).toBe(true);
      expect(stack.reserve("periodic:d")).toBe(false);
      for (const key of periodicKeys) stack.receive({ key, id: `${key}:round`, title: key, receivedAt: 0 });
      const task = fixture.engine.createTask({ title: "Task arrival" }).task;
      const taskKey = `task:${task.id}`;
      stack.receive({ key: taskKey, id: "task:event", title: task.title, task, receivedAt: 0 });
      const shown = visibleCues(stack.shown(), taskKey);
      expect(shown.slice(0, 3).map(cue => cue.key)).toEqual(periodicKeys);
      expect(shown[3]?.key).toBe(taskKey);
      expect(stack.reserve("periodic:d")).toBe(false);
      expect(stack.canDisplay(taskKey)).toBe(false);
      expect(stack.shown().slice(0, 3).map(cue => cue.key)).toEqual(periodicKeys);
    } finally { fixture.db.close(); }
  });
});
