import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HelperNotifier } from "../src/notifier.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Stand-in for TodoCueNotifier.app: prints one JSON line and exits with `code`, which is
 * exactly the contract the real helper keeps (see apps/macos/README.md).
 */
function fakeHelper(payload: unknown, code = 0): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todocue-notifier-"));
  tempDirs.push(dir);
  const bin = path.join(dir, "TodoCueNotifier");
  fs.writeFileSync(bin, `#!/bin/sh\necho '${JSON.stringify(payload)}'\nexit ${code}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

describe("HelperNotifier", () => {
  it("parses the helper's status payload", async () => {
    const notifier = new HelperNotifier({ helperPath: fakeHelper({ ok: true, authorization: "authorized", alertStyle: "banner" }) });
    await expect(notifier.status()).resolves.toMatchObject({ available: true, authorization: "authorized" });
  });

  it("surfaces needsSystemSettings when macOS will not prompt again", async () => {
    // This is the exit-0 shape the helper emits for a denied app. It must arrive as data,
    // not as a thrown error — a non-zero exit would make runHelper keep only `error`.
    const notifier = new HelperNotifier({
      helperPath: fakeHelper({
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
    const notifier = new HelperNotifier({ helperPath: fakeHelper({ ok: true, authorization: "authorized", alertStyle: "banner", needsSystemSettings: false }) });
    await expect(notifier.requestAuthorization()).resolves.toMatchObject({ authorization: "authorized", needsSystemSettings: false });
  });

  it("defaults needsSystemSettings to false for older helpers that omit it", async () => {
    const notifier = new HelperNotifier({ helperPath: fakeHelper({ ok: true, authorization: "denied", alertStyle: "banner" }) });
    await expect(notifier.requestAuthorization()).resolves.toMatchObject({ needsSystemSettings: false });
  });

  it("opens System Settings and reports the url", async () => {
    const url = "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.todocue.notifier";
    const notifier = new HelperNotifier({ helperPath: fakeHelper({ ok: true, url }) });
    await expect(notifier.openSystemSettings()).resolves.toEqual({ ok: true, url });
  });

  it("degrades instead of throwing when the helper is missing", async () => {
    const notifier = new HelperNotifier({ helperPath: "/nonexistent/TodoCueNotifier" });
    await expect(notifier.openSystemSettings()).resolves.toEqual({ ok: false, url: null });
    await expect(notifier.status()).resolves.toMatchObject({ available: false, authorization: "unknown" });
  });
});
