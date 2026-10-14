import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", installed: true, healthy: true, installedSpecs: [] as { home: string; nodePath: string; cliEntry: string; port?: number }[], starts: 0 }));
vi.mock("@todocue/server", async importOriginal => ({
  ...await importOriginal<typeof import("@todocue/server")>(),
  runtimeRoot: () => state.root,
  isRuntimeAlive: async () => state.healthy ? { pid: 101, baseUrl: "http://127.0.0.1:47832", token: "fixture", startedAt: "fixture" } : null,
}));
vi.mock("../src/windows-service.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/windows-service.js")>(),
  ensureWindowsCliPath: async () => false,
  windowsStatus: async () => ({ installed: state.installed, loaded: state.healthy }),
  windowsStart: async () => { state.starts++; state.healthy = true; },
  windowsInstall: async (paths: { home: string }, spec: { home: string; nodePath: string; cliEntry: string; port?: number }) => {
    state.installedSpecs.push(spec);
    fs.writeFileSync(path.join(paths.home, "windows-runtime.json"), JSON.stringify(spec, null, 2));
    state.installed = true; state.healthy = true;
  },
}));
import { bootstrapRuntime, installedWindowsPort } from "../src/bootstrap.js";
import { windowsSpec } from "../src/windows-service.js";
import { ensureHome, runtimePaths } from "@todocue/server";

let temporary: string;
let home: string;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "todocue-win-bootstrap-"));
  home = path.join(temporary, "自定义 home"); ensureHome(runtimePaths(home));
  state.root = path.join(temporary, "current app/runtime");
  fs.mkdirSync(path.dirname(state.root), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(state.root), "todocue-cli.exe"), "packaged launcher fixture");
  state.installed = true; state.healthy = true; state.installedSpecs = []; state.starts = 0;
  vi.stubEnv("LOCALAPPDATA", path.join(temporary, "user local"));
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.unstubAllEnvs(); fs.rmSync(temporary, { recursive: true, force: true });
});
async function bootstrapOnWindows() {
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
  try { return await bootstrapRuntime(home); }
  finally { Object.defineProperty(process, "platform", originalPlatform); }
}
function manifest(root = state.root, port?: number) {
  return windowsSpec(runtimePaths(home), { nodePath: path.join(root, "bin/node.exe"), cliEntry: path.join(root, "packages/cli/dist/index.js"), port });
}
function write(value: unknown) { fs.writeFileSync(path.join(home, "windows-runtime.json"), JSON.stringify(value, null, 2)); }

describe("Windows GUI bootstrap preserves service configuration", () => {
  it.each([47832, 0, 65535])("keeps selected port %i when updating installed runtime paths", async port => {
    write(manifest(path.join(temporary, "previous app/runtime"), port));
    const result = await bootstrapOnWindows();
    expect(result.running).toBe(true);
    expect(state.installedSpecs).toHaveLength(1);
    expect(state.installedSpecs[0]).toMatchObject({ port, nodePath: path.join(state.root, "bin/node.exe"), cliEntry: path.join(state.root, "packages/cli/dist/index.js") });
    expect(JSON.parse(fs.readFileSync(path.join(home, "windows-runtime.json"), "utf8")).port).toBe(port);
  });
  it("leaves an unchanged healthy service on its selected port without restarting it", async () => {
    write(manifest(state.root, 47832));
    expect((await bootstrapOnWindows()).running).toBe(true);
    expect(state.installedSpecs).toEqual([]); expect(state.starts).toBe(0);
  });
  it("starts an unchanged offline service without changing its selected port", async () => {
    write(manifest(state.root, 47832)); state.healthy = false;
    expect((await bootstrapOnWindows()).running).toBe(true);
    expect(state.installedSpecs).toEqual([]); expect(state.starts).toBe(1);
    expect(installedWindowsPort(home)).toBe(47832);
  });
  it.each([undefined, null, -1, 65536, 1.5, "47832"])("ignores an absent or invalid installed port %s", port => {
    write({ port }); expect(installedWindowsPort(home)).toBeUndefined();
  });
  it("can bootstrap a missing or malformed manifest with default configuration", async () => {
    expect(installedWindowsPort(home)).toBeUndefined();
    fs.writeFileSync(path.join(home, "windows-runtime.json"), "invalid JSON");
    expect((await bootstrapOnWindows()).running).toBe(true);
    expect(state.installedSpecs).toHaveLength(1); expect(state.installedSpecs[0]!.port).toBeUndefined();
  });
});
