import { describe, expect, it, vi } from "vitest";
import type { DesktopSettings } from "../src/bridge.js";
import { createSettingsWriter } from "../src/settingsWriter.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(save: (settings: DesktopSettings) => Promise<void>) {
  let settings: DesktopSettings = {
    language: "en", width: 340, height: 600, notchEnabled: true,
    notchDisplay: null, notchPlacement: "top", quietFullscreen: true,
    shortcut: null, autostart: false,
  };
  const busy = vi.fn(), failed = vi.fn();
  const write = createSettingsWriter({
    read: () => settings, save, saved: next => { settings = next; }, busy, failed,
  });
  return { write, busy, failed, read: () => settings };
}

describe("settings writes during continuous width input", () => {
  it("saves the latest pending input after the in-flight write without overlapping saves", async () => {
    const first = deferred(), last = deferred();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const f = fixture(save);
    const done = f.write({ width: 350 });
    await Promise.resolve();
    f.write({ width: 360 });
    f.write({ width: 370 });
    f.write({ width: 380 });
    expect(save).toHaveBeenCalledTimes(1);
    expect(f.read().width).toBe(340);
    first.resolve();
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0].width).toBe(380);
    expect(f.busy.mock.calls).toEqual([[true]]);
    last.resolve();
    await done;
    expect(f.read().width).toBe(380);
    expect(f.busy.mock.calls).toEqual([[true], [false]]);
  });

  it("merges queued edits onto the last confirmed settings", async () => {
    const first = deferred();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const f = fixture(save);
    const done = f.write({ language: "zh-CN" });
    await Promise.resolve();
    f.write({ width: 360 });
    f.write({ notchPlacement: "right" });
    first.resolve();
    await done;
    expect(f.read()).toMatchObject({ language: "zh-CN", width: 360, notchPlacement: "right", quietFullscreen: true });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("reports a failed write, keeps confirmed settings, and still saves newer input", async () => {
    const first = deferred(), next = deferred();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
    const f = fixture(save);
    const done = f.write({ width: 350, language: "zh-CN" });
    await Promise.resolve();
    f.write({ width: 370 });
    const error = new Error("Disk unavailable");
    first.reject(error);
    await Promise.resolve();
    expect(f.failed).toHaveBeenCalledWith(error);
    expect(f.read()).toMatchObject({ language: "en", width: 340 });
    expect(save.mock.calls[1]![0]).toMatchObject({ language: "en", width: 370 });
    next.resolve();
    await done;
    expect(f.read().width).toBe(370);
  });

  it("allows retry after failure, including a synchronous save error", async () => {
    const save = vi.fn().mockImplementationOnce(() => { throw new Error("Save unavailable"); }).mockResolvedValue(undefined);
    const f = fixture(save);
    await f.write({ width: 350 });
    expect(f.read().width).toBe(340);
    expect(f.failed).toHaveBeenCalledTimes(1);
    await f.write({ width: 360 });
    expect(f.read().width).toBe(360);
    expect(f.busy.mock.calls).toEqual([[true], [false], [true], [false]]);
  });
});
