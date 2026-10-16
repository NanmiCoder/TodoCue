import { describe, expect, it } from "vitest";
import { mediaPreferenceStore } from "../src/useReducedMotion.js";

describe("live reduced motion preference", () => {
  it("shares the OS listener, publishes both changes and detaches after the last consumer", () => {
    const events = new Set<() => void>();
    const media = {
      matches: false,
      addEventListener: (_: "change", listener: () => void) => events.add(listener),
      removeEventListener: (_: "change", listener: () => void) => events.delete(listener),
    };
    const store = mediaPreferenceStore(() => media);
    const observedA: boolean[] = [], observedB: boolean[] = [];
    const stopA = store.subscribe(() => observedA.push(store.getSnapshot()));
    const stopB = store.subscribe(() => observedB.push(store.getSnapshot()));
    expect(events.size).toBe(1);
    expect(store.getSnapshot()).toBe(false);
    media.matches = true; events.forEach(notify => notify());
    media.matches = false; events.forEach(notify => notify());
    expect(observedA).toEqual([true, false]);
    expect(observedB).toEqual([true, false]);
    stopA(); expect(events.size).toBe(1);
    stopB(); expect(events.size).toBe(0);
  });
});
