import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appBundle, packagedHelper } from "../src/bundle.js";

describe("standalone app layout", () => {
  it("locates its embedded helper after the app is copied to a different folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "todocue-bundle-"));
    try {
      const app = path.join(root, "Applications with spaces", "TodoCue.app");
      const runtime = path.join(app, "Contents/Resources/runtime");
      const helper = path.join(app, "Contents/Helpers/TodoCueNotifier.app/Contents/MacOS/TodoCueNotifier");
      fs.mkdirSync(runtime, { recursive: true });
      fs.mkdirSync(path.dirname(helper), { recursive: true });
      fs.writeFileSync(path.join(app, "Contents/Info.plist"), "bundle");
      fs.writeFileSync(helper, "helper");
      expect(appBundle(runtime)).toBe(app);
      expect(packagedHelper(appBundle(runtime))).toBe(helper);
      expect(appBundle(path.join(root, "checkout"))).toBeNull();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
