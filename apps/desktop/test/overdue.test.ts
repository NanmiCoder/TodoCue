import { describe, expect, it } from "vitest";
import { makeEngine } from "../../../packages/engine/test/helpers.js";
import { taskOverdue } from "../src/dates.js";

describe("shared UI deadline state matches exact and all-day deadlines", () => {
  it("changes precise deadlines only after the exact instant", () => {
    const fixture = makeEngine({ tz: "UTC", now: "2026-10-14T09:00:00.000Z" });
    try {
      const task = fixture.engine.createTask({ title: "Precise", dueAt: "2026-10-14T09:00:00.123Z" }).task;
      const instant = Date.parse(task.dueAt!);
      expect(taskOverdue(task, "2026-10-14", instant - 1)).toBe(false);
      expect(taskOverdue(task, "2026-10-14", instant)).toBe(false);
      expect(taskOverdue(task, "2026-10-14", instant + 1)).toBe(true);
    } finally { fixture.db.close(); }
  });

  it("compares precise deadlines independently of runtime and task calendar dates", () => {
    const fixture = makeEngine({ tz: "UTC", now: "2026-10-14T16:30:00.000Z" });
    try {
      const task = fixture.engine.createTask({ title: "Different zone", timezone: "Pacific/Auckland",
        dueAt: "2026-10-15T05:30:00+13:00" }).task;
      expect(taskOverdue(task, "2026-10-14", Date.parse("2026-10-14T16:30:00.001Z"))).toBe(true);
      expect(taskOverdue(task, "2026-10-15", Date.parse("2026-10-14T16:29:59.999Z"))).toBe(false);
    } finally { fixture.db.close(); }
  });

  it("keeps all-day deadlines current for the entire supplied today and changes at the next civil day", () => {
    const fixture = makeEngine({ tz: "UTC", now: "2026-10-14T08:00:00.000Z" });
    try {
      const task = fixture.engine.createTask({ title: "All day", dueDate: "2026-10-14", timezone: "Pacific/Auckland" }).task;
      expect(taskOverdue(task, "2026-10-13", Date.parse("2026-10-14T00:00:00.000Z"))).toBe(false);
      expect(taskOverdue(task, "2026-10-14", Date.parse("2026-10-14T23:59:59.999Z"))).toBe(false);
      expect(taskOverdue(task, "2026-10-15", Date.parse("2026-10-15T00:00:00.000Z"))).toBe(true);
    } finally { fixture.db.close(); }
  });

  it.each(["done", "cancelled", "skipped"] as const)("does not mark %s tasks overdue even when their deadline passed", status => {
    const fixture = makeEngine({ tz: "UTC", now: "2026-10-14T08:00:00.000Z" });
    try {
      const precise = fixture.engine.createTask({ title: "Past instant", dueAt: "2026-10-13T09:00:00.000Z" }).task;
      const allDay = fixture.engine.createTask({ title: "Past day", dueDate: "2026-10-13" }).task;
      expect(taskOverdue({ ...precise, status }, "2026-10-14", fixture.clock.now().getTime())).toBe(false);
      expect(taskOverdue({ ...allDay, status }, "2026-10-14", fixture.clock.now().getTime())).toBe(false);
    } finally { fixture.db.close(); }
  });

  it("does not infer a deadline from a past plan or reminder", () => {
    const fixture = makeEngine({ tz: "UTC", now: "2026-10-14T08:00:00.000Z" });
    try {
      const task = fixture.engine.createTask({ title: "Past plan", scheduledDate: "2026-10-13",
        reminderAt: "2026-10-13T09:00:00.000Z" }).task;
      expect(taskOverdue(task, "2026-10-14", fixture.clock.now().getTime())).toBe(false);
    } finally { fixture.db.close(); }
  });
});
