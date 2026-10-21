import { describe, expect, it } from "vitest";
import { CueStack } from "../src/model.js";

const rule = (round: number, delivery: string, patch: Record<string, unknown> = {}) =>
  ({
    id: "p1", enabled: true, state: "waiting", title: "站起来", timezone: "UTC", weekdays: [1, 2, 3, 4, 5, 6, 7],
    windows: [{ start: "00:00", end: "24:00" }], intervalMinutes: 40,
    currentOccurrence: { id: "o1", result: "pending", delivery, round, followUps: round - 1, snoozes: 0, scheduledAt: "2026-10-21T01:00:00Z", fireAt: "2026-10-21T01:00:00Z", ...patch },
  }) as never;
const arrive = (stack: CueStack, round: number) =>
  stack.receive({ key: "periodic:p1", id: `o1:${round}`, title: "站起来", periodic: rule(round, "displayed"), receivedAt: round } as never);

describe("a habit cue that the runtime asks again", () => {
  it("keeps its row while the next round waits for the scheduler, and the next arrival adds to ×N", () => {
    const stack = new CueStack();
    arrive(stack, 1);
    stack.sync([], [rule(2, "scheduled")]);
    expect(stack.entries.map((entry) => entry.key)).toEqual(["periodic:p1"]);
    expect(arrive(stack, 2)).toBe(true);
    expect(stack.entries.map((entry) => [entry.id, entry.repeats])).toEqual([["o1:2", 2]]);
  });
  it("still drops the row when the user snoozes it (followUps is reset, the round is scheduled)", () => {
    const stack = new CueStack();
    arrive(stack, 1);
    stack.sync([], [rule(2, "scheduled", { followUps: 0, snoozes: 1 })]);
    expect(stack.entries).toEqual([]);
  });
  it("drops the row when the occurrence ends, whatever its follow-up count", () => {
    for (const patch of [{ result: "completed" }, { result: "expired" }, { delivery: "missed", result: "expired" }]) {
      const stack = new CueStack();
      arrive(stack, 1);
      stack.sync([], [rule(2, "scheduled", patch)]);
      expect(stack.entries).toEqual([]);
    }
  });
});
