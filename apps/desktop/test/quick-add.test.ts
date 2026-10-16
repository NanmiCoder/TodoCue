import { describe, expect, it } from "vitest";
import { isCompositionKey, QuickAddRequest } from "../src/quickAdd.js";

describe("quick add keyboard and pending saves", () => {
  it("does not submit or dismiss on IME confirmation, including WebKit's final 229 key", () => {
    expect(isCompositionKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isCompositionKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isCompositionKey({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isCompositionKey({ isComposing: false, keyCode: 27 })).toBe(false);
  });
  it("locks before React renders, then allows a second deliberate same-title creation", () => {
    const request = new QuickAddRequest();
    const payload = { title: "同名任务", scheduledDate: "2026-10-14" };
    const first = request.begin(payload)!;
    expect(request.begin(payload)).toBeNull();
    expect(request.commit(first)).toBe(true);
    request.settle();
    expect(request.begin(payload)!.key).not.toBe(first.key);
  });
  it("preserves the next draft even when the user selects and retypes the submitted title", () => {
    const request = new QuickAddRequest();
    request.edited();
    const first = request.begin({ title: "Same" })!;
    request.edited(); // select all, type a replacement, then return to the same text
    request.edited();
    expect(request.commit(first)).toBe(false);
    request.settle();
    const next = request.begin({ title: "Same" })!;
    expect(next.key).not.toBe(first.key);
    expect(request.commit(next)).toBe(true);
  });
  it("retries an uncertain save with its original idempotency key, but a new date gets a new key", () => {
    const request = new QuickAddRequest();
    const payload = { title: "Retry", scheduledDate: "2026-10-14" };
    const first = request.begin(payload)!;
    request.settle(); // transport failed; do not commit
    const retry = request.begin(payload)!;
    expect(retry.key).toBe(first.key);
    request.settle();
    expect(request.begin({ ...payload, scheduledDate: "2026-10-15" })!.key).not.toBe(first.key);
  });
});
