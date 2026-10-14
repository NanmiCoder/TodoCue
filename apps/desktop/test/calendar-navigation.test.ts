import { describe, expect, it } from "vitest";
import { makeEngine } from "../../../packages/engine/test/helpers.js";
import { calendarBucket, calendarDays, stepCalendar } from "../src/dates.js";

describe("calendar navigation follows the SwiftUI civil-date rules", () => {
  it("moves both the month anchor and selection while preserving an ordinary day", () => {
    const state = { span: "month" as const, anchor: "2026-09-08", selected: "2026-09-08" };
    const next = stepCalendar(state, 1, 1);
    expect(next).toEqual({ anchor: "2026-10-08", selected: "2026-10-08" });
    expect(stepCalendar({ ...state, ...next }, -1, 1)).toEqual({ anchor: state.anchor, selected: state.selected });
    expect(state).toEqual({ span: "month", anchor: "2026-09-08", selected: "2026-09-08" });
  });

  it("uses the anchor for month paging after a different day was selected", () => {
    expect(stepCalendar({ span: "month", anchor: "2026-10-14", selected: "2026-10-25" }, 1, 1))
      .toEqual({ anchor: "2026-11-14", selected: "2026-11-14" });
  });

  it("clamps to a shorter month and continues from that clamped day", () => {
    const state = { span: "month" as const, anchor: "2026-01-31", selected: "2026-01-31" };
    const february = stepCalendar(state, 1, 1);
    expect(february).toEqual({ anchor: "2026-02-28", selected: "2026-02-28" });
    expect(stepCalendar({ ...state, ...february }, 1, 1)).toEqual({ anchor: "2026-03-28", selected: "2026-03-28" });
    expect(stepCalendar({ ...state, anchor: "2024-02-29", selected: "2024-02-29" }, 12, 1))
      .toEqual({ anchor: "2025-02-28", selected: "2025-02-28" });
  });

  it("crosses years in both directions without resetting the day to the first", () => {
    expect(stepCalendar({ span: "month", anchor: "2026-12-15", selected: "2026-12-15" }, 1, 7))
      .toEqual({ anchor: "2027-01-15", selected: "2027-01-15" });
    expect(stepCalendar({ span: "month", anchor: "2026-01-15", selected: "2026-01-15" }, -13, 1))
      .toEqual({ anchor: "2024-12-15", selected: "2024-12-15" });
  });

  it.each([1, 7])("keeps the selected weekday inside the paged week for first weekday %s", firstDay => {
    const state = { span: "week" as const, anchor: "2026-12-30", selected: "2026-12-29" };
    const next = stepCalendar(state, 1, firstDay);
    expect(next).toEqual({ anchor: "2027-01-06", selected: "2027-01-05" });
    expect(calendarDays("week", next.anchor, firstDay)).toContain(next.selected);
    expect(stepCalendar({ ...state, ...next }, -1, firstDay)).toEqual({ anchor: state.anchor, selected: state.selected });
  });

  it("keeps a selected Sunday on Sunday across a DST boundary", () => {
    const state = { span: "week" as const, anchor: "2026-03-07", selected: "2026-03-08" };
    const next = stepCalendar(state, 1, 1);
    expect(next).toEqual({ anchor: "2026-03-14", selected: "2026-03-15" });
    expect(calendarDays("week", next.anchor, 1)).toContain(next.selected);
  });

  it("places precise plan and due markers on their task-local dates without doubling due-only work", () => {
    const fixture = makeEngine({ tz: "UTC", now: "2026-10-14T08:00:00.000Z" });
    try {
      const planned = fixture.engine.createTask({ title: "Local plan", timezone: "Asia/Shanghai",
        scheduledAt: "2026-10-13T16:30:00.000Z", dueAt: "2026-10-14T16:30:00.000Z" }).task;
      const dueOnly = fixture.engine.createTask({ title: "Local due only", timezone: "Asia/Shanghai",
        dueAt: "2026-10-14T16:30:00.000Z" }).task;
      const tasks = [planned, dueOnly];
      expect(calendarBucket(tasks, "2026-10-14").planned.map(task => task.id)).toEqual([planned.id]);
      expect(calendarBucket(tasks, "2026-10-15").planned.map(task => task.id)).toEqual([dueOnly.id]);
      expect(calendarBucket(tasks, "2026-10-15").deadlines.map(task => task.id)).toEqual([planned.id]);
      expect(calendarBucket(tasks, "2026-10-13").planned).toEqual([]);
    } finally { fixture.db.close(); }
  });

  it("keeps completed, cancelled and skipped plans in history without live deadline marks", () => {
    const fixture = makeEngine({ tz: "UTC", now: "2026-10-14T08:00:00.000Z" });
    try {
      const complete = fixture.engine.createTask({ title: "Completed", scheduledDate: "2026-10-14", dueDate: "2026-10-15" }).task;
      const cancel = fixture.engine.createTask({ title: "Cancelled", scheduledDate: "2026-10-14", dueDate: "2026-10-15" }).task;
      const repeat = fixture.engine.createTask({ title: "Skipped", repeat: { kind: "daily" }, startDate: "2026-10-14", dueDate: "2026-10-15" }).task;
      const tasks = [fixture.engine.completeTask(complete.id), fixture.engine.cancelTask(cancel.id), fixture.engine.skipTask(repeat.id)];
      const day = calendarBucket(tasks, "2026-10-14");
      expect(day.planned).toEqual([]);
      expect(day.history.map(task => task.status)).toEqual(["done", "cancelled", "skipped"]);
      expect(calendarBucket(tasks, "2026-10-15").deadlines).toEqual([]);
    } finally { fixture.db.close(); }
  });
});
