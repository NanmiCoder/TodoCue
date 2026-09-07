import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureHome, runtimePaths } from "@todocue/server";
import { cliWrapper, installCliWrapper } from "../src/bootstrap.js";
import { bootstrapWithRetry } from "../src/launchagent.js";

const roots: string[] = [];
function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todocue-bootstrap-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("packaged CLI installation", () => {
  it("waits for transient launchd teardown but does not retry permanent errors", async () => {
    const pauses: number[] = [];
    let calls = 0;
    const result = await bootstrapWithRetry(async () => ++calls < 3
      ? { ok: false, out: "Bootstrap failed: 5: Input/output error" }
      : { ok: true, out: "" }, async (ms) => { pauses.push(ms); });
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    expect(pauses).toEqual([500, 1000]);
    calls = 0;
    await bootstrapWithRetry(async () => { calls++; return { ok: false, out: "invalid plist" }; }, async () => {});
    expect(calls).toBe(1);
    calls = 0;
    const failed = await bootstrapWithRetry(async () => { calls++; return { ok: false, out: "Bootstrap failed: 5" }; }, async () => {});
    expect(failed.ok).toBe(false);
    expect(calls).toBe(4);
  });
  it("executes from paths containing shell metacharacters and preserves arguments", () => {
    const root = temp();
    const dir = path.join(root, "TodoCue ' $literal `literal` App");
    fs.mkdirSync(dir);
    const entry = path.join(dir, "cli.mjs");
    fs.writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    const wrapper = path.join(root, "todocue");
    fs.writeFileSync(wrapper, cliWrapper(process.execPath, entry));
    const args = ["标题 with spaces", "$(should-not-run)", "'quote'", "--json"];
    expect(JSON.parse(execFileSync("/bin/sh", [wrapper, ...args], { encoding: "utf8" }))).toEqual(args);
  });

  it("preserves user data and unrelated commands during installation and app replacement", () => {
    const root = temp();
    const paths = runtimePaths(path.join(root, ".todocue"));
    ensureHome(paths);
    fs.writeFileSync(paths.database, "existing database bytes");
    fs.writeFileSync(paths.token, "existing token");
    const bin = path.join(root, "external-bin");
    fs.mkdirSync(bin);
    fs.symlinkSync("/unrelated/tool", path.join(bin, "todocue"));
    installCliWrapper(paths, "/Applications/TodoCue.app/node", "/Applications/TodoCue.app/cli.js", [bin]);
    installCliWrapper(paths, "/Applications/TodoCue.app/new-node", "/Applications/TodoCue.app/new-cli.js", [bin]);
    expect(fs.readlinkSync(path.join(bin, "todocue"))).toBe("/unrelated/tool");
    expect(fs.readFileSync(paths.database, "utf8")).toBe("existing database bytes");
    expect(fs.readFileSync(paths.token, "utf8")).toBe("existing token");
    expect(fs.readFileSync(path.join(paths.bin, "todocue"), "utf8")).toContain("new-node");
  });
});
