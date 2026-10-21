import { describe, expect, it } from "vitest";
import { followUpLabel, overdueMinutes, PERIODIC_TEMPLATES, periodicStateLabel, snoozeCount, timingExample, validatePeriodic } from "../src/periodic.js";

const now = Date.parse("2026-10-21T03:00:00.000Z");
const occurrence = (patch: Record<string, unknown> = {}) =>
  ({ result: "pending", scheduledAt: "2026-10-21T02:40:00.000Z", fireAt: "2026-10-21T02:55:00.000Z", round: 1, followUps: 0, ...patch }) as never;

describe("habit reminder wording and arithmetic", () => {
  it("counts overdue from when the cue was first due, not from the last re-ask", () => {
    expect(overdueMinutes({ currentOccurrence: occurrence() }, now)).toBe(20);
    expect(overdueMinutes({ currentOccurrence: occurrence({ result: "completed" }) }, now)).toBe(0);
    expect(overdueMinutes({ currentOccurrence: null }, now)).toBe(0);
    expect(overdueMinutes({ currentOccurrence: occurrence({ scheduledAt: "2026-10-21T03:05:00.000Z" }) }, now)).toBe(0);
  });
  it("reports the snoozes the runtime counted, not a guess from the round", () => {
    expect(snoozeCount({ currentOccurrence: occurrence({ round: 1, snoozes: 0 }) })).toBe(0);
    expect(snoozeCount({ currentOccurrence: occurrence({ round: 3, followUps: 2, snoozes: 0 }) })).toBe(0);
    // One follow-up then one snooze: three rounds, one snooze (followUps was reset by the snooze).
    expect(snoozeCount({ currentOccurrence: occurrence({ round: 3, followUps: 0, snoozes: 1 }) })).toBe(1);
    // Records saved before the counter existed had no follow-ups, so extra rounds were all snoozes.
    expect(snoozeCount({ currentOccurrence: occurrence({ round: 3, followUps: undefined }) })).toBe(2);
    expect(snoozeCount({ currentOccurrence: null })).toBe(0);
  });
  it("labels a waiting rule by how long it is overdue", () => {
    const rule = { state: "waiting", nextFireAt: null, timezone: "UTC", currentOccurrence: occurrence() } as const;
    expect(periodicStateLabel(rule, "zh-CN", new Date(now))).toBe("已超时 20 分钟");
    expect(periodicStateLabel(rule, "en", new Date(now))).toBe("20 min overdue");
    expect(periodicStateLabel({ ...rule, currentOccurrence: occurrence({ scheduledAt: "2026-10-21T03:00:00.000Z" }) }, "zh-CN", new Date(now))).toBe("等待确认");
    expect(periodicStateLabel({ state: "waiting", nextFireAt: null, timezone: "UTC" }, "zh-CN", new Date(now))).toBe("等待确认");
  });
  it("shows a worked example that differs by timing mode", () => {
    const windows = [{ start: "09:00", end: "18:00" }];
    expect(timingExample({ mode: "after_completion", intervalMinutes: 40, windows }, "zh-CN")).toBe("例：09:40 提醒，你 09:47 完成 → 下次 10:27");
    expect(timingExample({ mode: "fixed", intervalMinutes: 40, windows }, "zh-CN")).toBe("例：09:40 提醒，你 09:47 完成 → 下次仍是 10:20");
    expect(timingExample({ mode: "after_completion", intervalMinutes: 40, windows }, "en")).toBe("e.g. cue at 09:40, you finish at 09:47 → next 10:27");
    // Nothing sensible to show when the window is too short or the input is half-typed.
    expect(timingExample({ mode: "fixed", intervalMinutes: 40, windows: [{ start: "09:00", end: "10:00" }] }, "zh-CN")).toBeNull();
    expect(timingExample({ mode: "fixed", intervalMinutes: Number.NaN, windows }, "zh-CN")).toBeNull();
    expect(timingExample({ mode: "fixed", intervalMinutes: 30, windows: [] }, "zh-CN")).toBeNull();
  });
  it("labels follow-up choices and ships templates that pass the form validation", () => {
    expect(followUpLabel(0, "zh-CN")).toBe("不再提醒");
    expect(followUpLabel(10, "zh-CN")).toBe("10 分钟后再提醒");
    expect(followUpLabel(10, "en")).toBe("Ask again after 10 min");
    for (const template of PERIODIC_TEMPLATES)
      for (const index of [0, 1] as const)
        expect(validatePeriodic({ title: template.title[index], intervalMinutes: template.intervalMinutes, windows: [{ start: "09:00", end: "18:00" }], weekdays: [1], timezone: "UTC" }, "zh-CN")).toEqual({});
  });
});
