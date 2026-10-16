import { describe, expect, it } from "vitest";
import {
  ActionGate,
  DOM_POINTER_PRIORITY_MS,
  MENU_ABSENCE_MS,
  PERIODIC_RENDER_MAX_WAIT,
  PIN_MEMORY_MS,
  STACK_RETURN_DELAY,
  deferredAfterExpand,
  errorFeedback,
  menuAbandoned,
  periodicRenderGate,
  pointerIsOutside,
  recallPin,
  rememberPin,
  restorePinAfterMenu,
} from "../src/model.js";

describe("the pin after a menu closes", () => {
  it("gives back the earlier pin only while the quick look is still open", () => {
    expect(restorePinAfterMenu({ before: true, expanded: true })).toBe(true);
    expect(restorePinAfterMenu({ before: false, expanded: true })).toBe(false);
  });
  it("never leaves a closed quick look pinned (outside click or panel opened while the menu was up)", () => {
    expect(restorePinAfterMenu({ before: true, expanded: false })).toBe(false);
  });
});

describe("what a secondary press remembers", () => {
  it("is used by the menu that follows it", () => {
    expect(recallPin(rememberPin(true, 1000), 1100)).toBe(true);
    expect(recallPin(rememberPin(false, 1000), 1100)).toBe(false);
  });
  it("expires, so a menu opened later by keyboard or long press does not inherit it", () => {
    expect(recallPin(rememberPin(false, 1000), 1000 + PIN_MEMORY_MS + 1)).toBeNull();
    expect(recallPin(null, 1000)).toBeNull();
  });
});

describe("where the pointer is, in the native window", () => {
  const host = (inside: boolean, at: number) => ({ inside, at });
  it("the browser preview keeps using geometry", () => {
    expect(pointerIsOutside({ native: false, geometryAway: true, host: null, dom: null })).toBe(true);
    expect(pointerIsOutside({ native: false, geometryAway: false, host: host(false, 1), dom: null })).toBe(false);
  });
  it("the page's box is the whole window, so geometry is ignored once the host has spoken", () => {
    expect(pointerIsOutside({ native: true, geometryAway: false, host: host(false, 1000), dom: null })).toBe(true);
    expect(pointerIsOutside({ native: true, geometryAway: false, host: host(true, 1000), dom: null })).toBe(false);
  });
  it("the newest evidence wins and a DOM event wins a close call", () => {
    expect(pointerIsOutside({ native: true, geometryAway: false, host: host(false, 5000), dom: host(true, 1000) })).toBe(true);
    expect(pointerIsOutside({ native: true, geometryAway: false, host: host(false, 1000), dom: host(true, 5000) })).toBe(false);
    expect(
      pointerIsOutside({ native: true, geometryAway: false, host: host(false, 1000 + DOM_POINTER_PRIORITY_MS - 1), dom: host(true, 1000) }),
    ).toBe(false);
  });
  it("falls back to geometry when nothing was reported", () => {
    expect(pointerIsOutside({ native: true, geometryAway: true, host: null, dom: null })).toBe(true);
  });
});

describe("an abandoned menu (Windows has no global click monitor; unverified on hardware)", () => {
  const away = (at: number) => ({ inside: false, at });
  it("closes once the host has seen the pointer outside for long enough", () => {
    expect(menuAbandoned({ host: away(1000), dom: null, now: 1000 + MENU_ABSENCE_MS })).toBe(true);
    expect(menuAbandoned({ host: away(1000), dom: null, now: 1000 + MENU_ABSENCE_MS - 1 })).toBe(false);
  });
  it("stays while the pointer is in the window or the page saw it return", () => {
    expect(menuAbandoned({ host: { inside: true, at: 0 }, dom: null, now: 99999 })).toBe(false);
    expect(menuAbandoned({ host: null, dom: null, now: 99999 })).toBe(false);
    expect(menuAbandoned({ host: away(1000), dom: { inside: true, at: 1500 }, now: 99999 })).toBe(false);
  });
});

describe("reminders deferred under the pointer", () => {
  it("are listed live once the quick look opens, so no stale '+N new' remains after it closes", () => {
    expect(deferredAfterExpand(["a", "b"], true)).toEqual([]);
    expect(deferredAfterExpand(["a", "b"], false)).toEqual(["a", "b"]);
  });
});

describe("a periodic reminder arriving while the stack is returning", () => {
  it("waits for the stack instead of reporting a failed display", () => {
    expect(periodicRenderGate({ rendered: false, held: true, waited: 0 })).toBe("wait");
    expect(periodicRenderGate({ rendered: true, held: true, waited: 100 })).toBe("show");
  });
  it("gives up after the hold plus a margin, and never waits without a hold", () => {
    expect(PERIODIC_RENDER_MAX_WAIT).toBeGreaterThan(STACK_RETURN_DELAY);
    expect(periodicRenderGate({ rendered: false, held: true, waited: PERIODIC_RENDER_MAX_WAIT })).toBe("fail");
    expect(periodicRenderGate({ rendered: false, held: false, waited: 0 })).toBe("fail");
  });
});

describe("notch writes", () => {
  const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  it("drops a click while another write is running", async () => {
    const gate = new ActionGate();
    const ran: string[] = [];
    const first = gate.run(async () => { await later(20); ran.push("first"); });
    expect(gate.busy).toBe(true);
    expect(await gate.run(async () => { ran.push("dropped"); })).toBe(false);
    await first;
    expect(ran).toEqual(["first"]);
    expect(gate.busy).toBe(false);
  });
  it("an undo waits for the running write and then runs exactly once", async () => {
    const gate = new ActionGate();
    const ran: string[] = [];
    const first = gate.run(async () => { await later(20); ran.push("refresh"); });
    const undo = gate.whenIdle(async () => { ran.push("undo"); });
    await Promise.all([first, undo]);
    expect(ran).toEqual(["refresh", "undo"]);
  });
  it("two queued undos run one after the other, each once", async () => {
    const gate = new ActionGate();
    const ran: string[] = [];
    void gate.run(async () => { await later(10); ran.push("write"); });
    await Promise.all([
      gate.whenIdle(async () => { await later(5); ran.push("u1"); }),
      gate.whenIdle(async () => { ran.push("u2"); }),
    ]);
    expect(ran).toEqual(["write", "u1", "u2"]);
  });
  it("a failing write frees the gate", async () => {
    const gate = new ActionGate();
    await expect(gate.run(async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(gate.busy).toBe(false);
    expect(await gate.run(async () => {})).toBe(true);
  });
});

describe("what a failed call says", () => {
  it("explains a version conflict and asks for a refresh", () => {
    const conflict = Object.assign(new Error("VERSION_CONFLICT: stale"), { code: "VERSION_CONFLICT" });
    expect(errorFeedback(conflict, "en")).toEqual({ message: "Changed elsewhere. Refreshed.", refresh: true });
    expect(errorFeedback(conflict, "zh-CN").message).toBe("任务已在别处修改，已刷新");
  });
  it("never shows a raw 'Error: ...' wrapper", () => {
    const failure = errorFeedback(new Error("boom"), "en");
    expect(failure).toEqual({ message: "boom", refresh: false });
  });
});
