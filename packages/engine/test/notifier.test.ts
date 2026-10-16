import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HelperNotifier, type HelperNotifierOptions } from "../src/notifier.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Stand-in for TodoCueNotifier.app: prints one JSON line and exits with `code`, which is
 * exactly the contract the real helper keeps (see apps/macos/README.md).
 */
function fakeHelper(payload: unknown, code = 0): HelperNotifierOptions {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todocue-notifier-"));
  tempDirs.push(dir);
  const script = path.join(dir, "notifier.cjs");
  fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify(payload) + "\n")}); process.exit(${code});`);
  return { helperPath: process.execPath, helperArgs: [script] };
}

describe("HelperNotifier", () => {
  it("passes a CLI --home origin to the Windows helper even when the environment has no home", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todocue-notifier-origin-"));
    tempDirs.push(dir);
    const script = path.join(dir, "notifier.cjs"), record = path.join(dir, "args.json");
    fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({ok:true,channel:'windows-toast'}));`);
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { ...original, value: "win32" });
      const home = path.join(dir, "custom data");
      const notifier = new HelperNotifier({ helperPath: process.execPath, helperArgs: [script], home, allowOsascriptFallback: false });
      await notifier.deliver({ id: "r_123", taskId: "t_123", title: "Reminder" });
      const args = JSON.parse(fs.readFileSync(record, "utf8")) as string[];
      expect(args[0]).toBe("deliver");
      expect(args.slice(-2)).toEqual(["--home", home]);
    } finally { Object.defineProperty(process, "platform", original); }
  });
  it("parses the helper's status payload", async () => {
    const notifier = new HelperNotifier({ ...fakeHelper({ ok: true, authorization: "authorized", alertStyle: "banner" }) });
    await expect(notifier.status()).resolves.toMatchObject({ available: true, authorization: "authorized" });
  });

  it("surfaces needsSystemSettings when macOS will not prompt again", async () => {
    // This is the exit-0 shape the helper emits for a denied app. It must arrive as data,
    // not as a thrown error — a non-zero exit would make runHelper keep only `error`.
    const notifier = new HelperNotifier({
      ...fakeHelper({
        ok: false,
        authorization: "denied",
        alertStyle: "banner",
        needsSystemSettings: true,
        error: "notifications denied; macOS will not prompt again",
      }),
    });
    const status = await notifier.requestAuthorization();
    expect(status.authorization).toBe("denied");
    expect(status.needsSystemSettings).toBe(true);
  });

  it("reports no recovery needed once authorized", async () => {
    const notifier = new HelperNotifier({ ...fakeHelper({ ok: true, authorization: "authorized", alertStyle: "banner", needsSystemSettings: false }) });
    await expect(notifier.requestAuthorization()).resolves.toMatchObject({ authorization: "authorized", needsSystemSettings: false });
  });

  it("defaults needsSystemSettings to false for older helpers that omit it", async () => {
    const notifier = new HelperNotifier({ ...fakeHelper({ ok: true, authorization: "denied", alertStyle: "banner" }) });
    await expect(notifier.requestAuthorization()).resolves.toMatchObject({ needsSystemSettings: false });
  });

  it("opens System Settings and reports the url", async () => {
    const url = "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.todocue.notifier";
    const notifier = new HelperNotifier({ ...fakeHelper({ ok: true, url }) });
    await expect(notifier.openSystemSettings()).resolves.toEqual({ ok: true, url });
  });

  it("degrades instead of throwing when the helper is missing", async () => {
    const notifier = new HelperNotifier({ helperPath: "/nonexistent/TodoCueNotifier" });
    await expect(notifier.openSystemSettings()).resolves.toEqual({ ok: false, url: null });
    await expect(notifier.status()).resolves.toMatchObject({ available: false, authorization: "unknown" });
  });
});
