import { describe, expect, it } from "vitest";
import {
  cueMeta,
  cuePose,
  foldsStack,
  freezeJoins,
  rippleProgress,
  shouldCollapseForPanel,
  shouldDeferArrival,
  taskCountdown,
  type Cue,
} from "../src/model.js";
import { rescheduleToTomorrow } from "../src/dates.js";
import { makeEngine } from "../../../packages/engine/test/helpers.js";

const cue = (key: string): Cue => ({ key, id: key, title: key, receivedAt: 0, repeats: 1 });

describe("quick look closing returns to the reminder stack", () => {
  it("folds the stack only for the explicit fold button", () => {
    for (const reason of ["escape", "panel-opened", "outside", "leave", "space-changed"] as const)
      expect(foldsStack(reason)).toBe(false);
    expect(foldsStack("fold-button")).toBe(true);
  });
  it("opening the panel touches the notch only while its quick look is open", () => {
    expect(shouldCollapseForPanel({ expanded: true })).toBe(true);
    expect(shouldCollapseForPanel({ expanded: false })).toBe(false);
  });
});

describe("arrivals are deferred only under a pointer resting on the stack", () => {
  it("lets the quick look and a hover-free stack take arrivals live", () => {
    expect(shouldDeferArrival({ stackShown: false, pointerOnStack: true, alreadyListed: false })).toBe(false);
    expect(shouldDeferArrival({ stackShown: true, pointerOnStack: false, alreadyListed: false })).toBe(false);
  });
  it("defers a new row under the pointer but never an update of a listed row", () => {
    expect(shouldDeferArrival({ stackShown: true, pointerOnStack: true, alreadyListed: false })).toBe(true);
    expect(shouldDeferArrival({ stackShown: true, pointerOnStack: true, alreadyListed: true })).toBe(false);
  });
  it("freezes joins but still lets rows leave", () => {
    const current = [cue("a"), cue("b"), cue("c")];
    expect(freezeJoins(current, [cue("a"), cue("c"), cue("d")]).map((c) => c.key)).toEqual(["a", "c"]);
    expect(freezeJoins([], [cue("x")])).toEqual([]);
  });
});

describe("Cue motion keyframes match ReminderCue.swift", () => {
  it("rests outside its window or when motion is reduced", () => {
    expect(rippleProgress(-0.1, false)).toBe(0);
    expect(rippleProgress(1.1, false)).toBe(0);
    expect(rippleProgress(0.5, true)).toBe(0);
    expect(cuePose(0.5, true)).toEqual({ scaleX: 1, scaleY: 1, offsetY: 0, rotation: 0 });
    expect(cuePose(0.9, false)).toEqual({ scaleX: 1, scaleY: 1, offsetY: 0, rotation: 0 });
  });
  it("eases the ripple out and hits the hop keyframes", () => {
    expect(rippleProgress(0.55, false)).toBeCloseTo(1 - 0.5 ** 3, 6);
    expect(cuePose(0.12, false)).toMatchObject({ scaleX: 1.12, scaleY: 0.88, offsetY: 2, rotation: -5 });
    expect(cuePose(0.34, false)).toMatchObject({ scaleX: 0.94, scaleY: 1.06, offsetY: -7, rotation: 8 });
    expect(cuePose(0.54, false)).toMatchObject({ scaleX: 1.06, scaleY: 0.94, offsetY: 1, rotation: -3 });
    const mid = cuePose(0.23, false);
    expect(mid.offsetY).toBeGreaterThan(-7);
    expect(mid.offsetY).toBeLessThan(2);
  });
});

describe("next-step countdown and cue meta wording", () => {
  const now = Date.parse("2026-10-17T10:00:00.000Z");
  it("labels a planned time before and after it", () => {
    expect(taskCountdown({ scheduledAt: "2026-10-17T10:12:00.000Z" }, now, "zh-CN")).toEqual({ text: "还有 12 分钟", late: false });
    expect(taskCountdown({ scheduledAt: "2026-10-17T11:30:00.000Z" }, now, "en")).toEqual({ text: "In 1 hr 30 min", late: false });
    expect(taskCountdown({ scheduledAt: "2026-10-17T09:59:50.000Z" }, now, "zh-CN")).toEqual({ text: "刚到时间", late: true });
  });
  it("labels a deadline, and nothing for an undated task", () => {
    expect(taskCountdown({ dueAt: "2026-10-14T10:00:00.000Z" }, now, "zh-CN")).toEqual({ text: "已逾期 3 天", late: true });
    expect(taskCountdown({ dueAt: "2026-10-17T10:00:20.000Z" }, now, "en")).toEqual({ text: "Due now", late: false });
    expect(taskCountdown({}, now, "en")).toBeNull();
  });
  it("describes a periodic rule by interval and a task by countdown", () => {
    const periodic = { intervalMinutes: 30, currentOccurrence: { result: "pending", fireAt: "2026-10-17T09:15:00.000Z" } } as never;
    expect(cueMeta({ ...cue("p"), periodic }, now, "zh-CN")).toBe("每 30 分钟 · 已等 45 分钟");
    expect(cueMeta({ ...cue("p"), periodic }, now, "en")).toBe("Every 30 minutes · Waiting 45 min");
    const task = { scheduledAt: "2026-10-17T10:05:00.000Z" } as never;
    expect(cueMeta({ ...cue("t"), task }, now, "zh-CN")).toBe("任务提醒 · 还有 5 分钟");
    expect(cueMeta({ ...cue("t"), count: 3 }, now, "zh-CN")).toBe("还有 2 件事等你，点开看看。");
  });
});

describe("move to tomorrow takes today's and overdue deadlines along", () => {
  it("moves an all-day plan and a deadline that is today", () => {
    const fixture = makeEngine({ tz: "UTC", now: "2026-10-17T08:00:00.000Z" });
    try {
      const task = fixture.engine.createTask({ title: "Due today", scheduledDate: "2026-10-17", dueDate: "2026-10-17" }).task;
      expect(rescheduleToTomorrow(task, "2026-10-17")).toMatchObject({
        scheduledDate: "2026-10-18", scheduledAt: null, dueDate: "2026-10-18", dueAt: null,
      });
    } finally { fixture.db.close(); }
  });
  it("keeps the time of day and keeps a deadline that is still ahead", () => {
    const fixture = makeEngine({ tz: "UTC", now: "2026-10-17T08:00:00.000Z" });
    try {
      const task = fixture.engine.createTask({
        title: "Timed", scheduledAt: "2026-10-17T09:30:00.000Z", dueAt: "2026-10-25T12:00:00.000Z",
      }).task;
      const input = rescheduleToTomorrow(task, "2026-10-17");
      expect(input.scheduledAt).toBe("2026-10-18T09:30:00.000Z");
      expect(input.dueAt).toBeUndefined();
      expect(input.dueDate).toBeUndefined();
    } finally { fixture.db.close(); }
  });
  it("moves an overdue precise deadline to the same time tomorrow", () => {
    const fixture = makeEngine({ tz: "UTC", now: "2026-10-17T08:00:00.000Z" });
    try {
      const task = fixture.engine.createTask({ title: "Late", dueAt: "2026-10-15T16:00:00.000Z" }).task;
      const input = rescheduleToTomorrow(task, "2026-10-17");
      expect(input).toMatchObject({ scheduledDate: "2026-10-18", dueAt: "2026-10-18T16:00:00.000Z", dueDate: null });
    } finally { fixture.db.close(); }
  });
});
