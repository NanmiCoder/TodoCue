import { afterEach, describe, expect, it, vi } from "vitest";
import { animateReveal, checkPress, pageDirection, reveal, revealDelay, tabDirection, tabOrder, tabSwap, watchReveal } from "../src/motionKit.js";
import { motionTokens, spring } from "../src/tokens.js";

describe("SwiftUI spring conversion", () => {
  it("maps response and damping fraction to mass-one physical springs", () => {
    for (const [response, fraction] of [[0.26, 0.82], [0.42, 0.84], [0.34, 0.58], [0.36, 1], [0.32, 0.86], [0.4, 0.9]] as const) {
      const value = spring(response, fraction);
      expect(value.mass).toBe(1);
      expect(value.stiffness).toBeCloseTo((2 * Math.PI / response) ** 2, 9);
      expect(value.damping).toBeCloseTo(4 * Math.PI * fraction / response, 9);
    }
  });
  it("keeps the Dial tokens on the documented parameters", () => {
    expect(motionTokens.snap).toEqual(spring(0.26, 0.82));
    expect(motionTokens.settle).toEqual(spring(0.42, 0.84));
    expect(motionTokens.pop).toEqual(spring(0.34, 0.58));
    expect(motionTokens.list).toEqual(spring(0.36, 1));
  });
});

describe("direction of replacement animations", () => {
  it("follows the lit dot: forward or staying slides in from the right, backwards from the left", () => {
    expect(tabOrder).toEqual(["today", "upcoming", "all"]);
    expect(tabDirection("today", "upcoming")).toBe(1);
    expect(tabDirection("today", "all")).toBe(1);
    expect(tabDirection("all", "today")).toBe(-1);
    expect(tabDirection("upcoming", "today")).toBe(-1);
    expect(tabDirection("all", "all")).toBe(1);
  });
  it("pages the calendar towards the later date", () => {
    expect(pageDirection("2026-10-01", "2026-11-01")).toBe(1);
    expect(pageDirection("2026-10-01", "2026-09-01")).toBe(-1);
    expect(pageDirection("2026-10-01", "2026-10-01")).toBe(1);
  });
  it("uses the documented tab swap distance and delay", () => {
    expect(tabSwap).toEqual({ distance: 16, delay: 0.04, outDuration: 0.1 });
  });
});

describe("completion and arrival timings", () => {
  it("presses, overshoots and settles over 0.54s like the keyframeAnimator", () => {
    expect(checkPress.values).toEqual([1, 0.82, 1.16, 1]);
    expect(checkPress.duration).toBeCloseTo(0.54, 9);
    expect(checkPress.times[0]).toBe(0);
    expect(checkPress.times[1]).toBeCloseTo(0.08 / 0.54, 9);
    expect(checkPress.times[2]).toBeCloseTo(0.24 / 0.54, 9);
    expect(checkPress.times[3]).toBe(1);
  });
  it("staggers the tiles 45ms apart from 18pt", () => {
    expect(reveal.offset).toBe(18);
    expect([0, 1, 2, 3].map(revealDelay)).toEqual([0, 0.045, 0.09, 0.135].map((value) => expect.closeTo(value, 9)));
  });
});

describe("tile reveal keeps its resting styles visible", () => {
  it("uses a temporary browser effect that releases opacity after completion", () => {
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }) as unknown as Animation);
    const element = { animate, style: { opacity: "1", transform: "none" } };
    const stop = animateReveal(element, 2);
    const [frames, options] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions];
    expect(frames).toEqual([
      { translate: "18px 0", opacity: 0 },
      { translate: "0px 0", opacity: 1 },
    ]);
    // No forwards fill: a completed/cancelled effect cannot retain an invisible frame, even if
    // the WebView suspends JS callbacks. The ordinary styles never depend on onComplete running.
    expect(options.fill).toBe("backwards");
    expect(options.delay).toBeCloseTo(90);
    expect(element.style).toEqual({ opacity: "1", transform: "none" });
    stop();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("lets next-card and route transitions retain ownership of their opacity and transforms", () => {
    const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);
    animateReveal({ animate }, 1, false);
    const [frames] = animate.mock.calls[0] as unknown as [Keyframe[]];
    expect(frames).toEqual([{ translate: "18px 0" }, { translate: "0px 0" }]);
  });
});

describe("panel reveal fallback", () => {
  const listeners: Record<string, Array<() => void>> = {};
  const target = (name: string) => ({
    addEventListener: (type: string, handler: () => void) => ((listeners[`${name}:${type}`] ??= []).push(handler)),
    removeEventListener: (type: string, handler: () => void) => {
      listeners[`${name}:${type}`] = (listeners[`${name}:${type}`] ?? []).filter((item) => item !== handler);
    },
  });
  const emit = (key: string) => (listeners[key] ?? []).forEach((handler) => handler());
  afterEach(() => { vi.unstubAllGlobals(); for (const key of Object.keys(listeners)) delete listeners[key]; });
  function setup() {
    const doc = { ...target("document"), hidden: false };
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", target("window"));
    const clock = vi.spyOn(performance, "now");
    return { doc, clock };
  }
  it("counts hidden -> visible once, ignores plain focus, and debounces the host event", async () => {
    const { doc, clock } = setup();
    let now = 1000; clock.mockImplementation(() => now);
    const calls = vi.fn();
    const hosted = { fire: () => {} };
    const stop = watchReveal(calls, async (handler) => { hosted.fire = handler; return () => {}; });
    await Promise.resolve();
    emit("window:focus");
    expect(calls).not.toHaveBeenCalled();
    doc.hidden = true; emit("document:visibilitychange");
    doc.hidden = false; now += 1000; emit("document:visibilitychange");
    expect(calls).toHaveBeenCalledTimes(1);
    now += 1000; emit("window:focus");
    expect(calls).toHaveBeenCalledTimes(1);
    now += 1000; hosted.fire();
    expect(calls).toHaveBeenCalledTimes(2);
    now += 100; hosted.fire();
    expect(calls).toHaveBeenCalledTimes(2);
    stop();
    expect(listeners["window:focus"]).toEqual([]);
  });
});
