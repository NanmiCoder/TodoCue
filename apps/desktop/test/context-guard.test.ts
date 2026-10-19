import { afterEach, describe, expect, it, vi } from "vitest";
import { installContextMenuGuard } from "../src/contextGuard.js";

class FakeElement {
  constructor(private readonly matches: string[]) {}
  closest(selector: string) {
    return this.matches.includes(selector) ? this : null;
  }
}

function rightClick(target: FakeElement, selection: string, development = false) {
  let handler: (event: unknown) => void = () => {};
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("document", { addEventListener: (_: string, fn: typeof handler) => (handler = fn), removeEventListener: () => {} });
  vi.stubGlobal("window", { getSelection: () => ({ toString: () => selection }) });
  installContextMenuGuard(development);
  const event = { defaultPrevented: false, target, preventDefault: vi.fn() };
  handler(event);
  return event.preventDefault.mock.calls.length > 0;
}

afterEach(() => vi.unstubAllGlobals());

describe("the context menu guard", () => {
  it("suppresses the native menu on a word WebKit auto-selected under the pointer", () => {
    expect(rightClick(new FakeElement([]), "专家")).toBe(true);
  });
  it("keeps the native menu for selected text in a selectable region", () => {
    expect(rightClick(new FakeElement(["[data-selectable]"]), "专家")).toBe(false);
  });
  it("suppresses it in a selectable region when nothing is selected", () => {
    expect(rightClick(new FakeElement(["[data-selectable]"]), "")).toBe(true);
  });
  it("keeps it in fields and in development builds", () => {
    expect(rightClick(new FakeElement(["input, textarea, [contenteditable=''], [contenteditable='true']"]), "")).toBe(false);
    expect(rightClick(new FakeElement([]), "", true)).toBe(false);
  });
});
