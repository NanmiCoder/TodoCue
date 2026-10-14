import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureHome, runtimePaths } from "@todocue/server";

const scheduler = vi.hoisted(() => ({
  tasks: new Map<string, { home: string; running: Record<string, unknown> | null }>(),
  calls: [] as { command: string; args: string[]; env?: NodeJS.ProcessEnv }[],
  userPath: ["C:\\Other tools"],
  failCreate: false, failStop: false,
  stopGate: undefined as Promise<void> | undefined,
}));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const execFile = Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: async (command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
    scheduler.calls.push({ command, args, env: options.env });
    const name = args.includes("/TN") ? args[args.indexOf("/TN") + 1]! : options.env?.TODOCUE_TASK_NAME ?? "";
    const task = scheduler.tasks.get(name);
    if (command === "powershell.exe") {
      const script = args.at(-1)!;
      if (script.includes("WindowsIdentity")) return { stdout: "S-1-5-21-123-456-1001", stderr: "" };
      if (options.env?.TODOCUE_INSTALL_BIN) {
        const bin = options.env.TODOCUE_INSTALL_BIN;
        if (script.includes(" -ine ")) scheduler.userPath = scheduler.userPath.filter(value => value !== bin);
        else if (!scheduler.userPath.includes(bin)) { scheduler.userPath.push(bin); return { stdout: "added", stderr: "" }; }
        return { stdout: "existing", stderr: "" };
      }
      if (script.includes("WaitOne")) {
        if (scheduler.failStop) throw new Error("Runtime did not stop");
        if (scheduler.stopGate) await scheduler.stopGate;
        if (task) task.running = null;
        return { stdout: "", stderr: "" };
      }
      return { stdout: task?.running ? "4" : "3", stderr: "" };
    }
    if (command === "schtasks.exe") {
      if (args.includes("/Query") && !task) throw new Error("Task missing");
      if (args.includes("/Create")) {
        if (scheduler.failCreate) throw new Error("Registration refused");
        if (task?.running) throw new Error("Old host is still running");
        const xml = fs.readFileSync(args[args.indexOf("/XML") + 1]!, "utf16le");
        const home = xml.match(/<Arguments>--home &quot;([^<]+)&quot;<\/Arguments>/)![1]!.replace(/&amp;/g, "&");
        scheduler.tasks.set(name, { home, running: null });
      }
      if (args.includes("/Run")) {
        if (!task) throw new Error("Task missing");
        task.running ??= JSON.parse(fs.readFileSync(path.join(task.home, "windows-runtime.json"), "utf8"));
      }
      // /End returns before the host exits. The WaitOne branch completes the stop.
      if (args.includes("/Delete")) scheduler.tasks.delete(name);
    }
    return { stdout: "Success", stderr: "" };
  } });
  return { ...original, execFile };
});
import { ensureWindowsCliPath, taskName, windowsInstall, windowsProductIntegration, windowsUninstall, type WindowsRuntimeSpec } from "../src/windows-service.js";
import { registerWindowsHome, windowsHomes } from "../src/windows-integration.js";
import { installWindowsCli } from "../src/bootstrap.js";

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "todocue-windows-product-"));
  vi.stubEnv("LOCALAPPDATA", path.join(base, "user-local"));
  vi.stubEnv("TODOCUE_HOME", "");
});
afterEach(() => {
  vi.unstubAllEnvs(); fs.rmSync(base, { recursive: true, force: true });
  scheduler.tasks.clear(); scheduler.calls = []; scheduler.failCreate = false; scheduler.failStop = false; scheduler.stopGate = undefined; scheduler.userPath = ["C:\\Other tools"];
});
function fixture(homeName = "custom data & files", appName = "Installed TodoCue") {
  const paths = runtimePaths(path.join(base, homeName)); ensureHome(paths);
  const app = path.join(base, appName), root = path.join(app, "runtime");
  const spec: WindowsRuntimeSpec = { home: paths.home, nodePath: path.join(root, "bin/node.exe"), cliEntry: path.join(root, "packages/cli/dist/index.js"), hostPath: path.join(app, "todocue-runtime.exe"), notifierPath: path.join(app, "TodoCueNotifier.exe"), port: 47831 };
  for (const file of [spec.nodePath, spec.cliEntry, spec.hostPath, spec.notifierPath]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "fixture"); }
  return { paths, spec, root, app };
}
describe("Windows product lifecycle without the original shell environment", () => {
  it("stops every owned custom home on upgrade and resumes its original configuration", async () => {
    const a = fixture(), b = fixture("another custom home"), other = fixture("other data", "Other install");
    for (const f of [a, b, other]) await windowsInstall(f.paths, f.spec);
    await windowsProductIntegration(a.root, "stop");
    expect(scheduler.tasks.get(taskName(a.paths.home))?.running).toBeNull();
    expect(scheduler.tasks.get(taskName(b.paths.home))?.running).toBeNull();
    expect(scheduler.tasks.get(taskName(other.paths.home))?.running).toMatchObject({ port: 47831 });
    // The old uninstaller and PREINSTALL can both stop during maintenance.
    await windowsProductIntegration(a.root, "stop");
    await windowsProductIntegration(a.root, "start");
    for (const f of [a, b]) expect(scheduler.tasks.get(taskName(f.paths.home))?.running).toMatchObject({ home: f.paths.home, port: 47831 });
  });
  it("waits for host exit before replacing the manifest and starts with the new port", async () => {
    const f = fixture(); await windowsInstall(f.paths, f.spec);
    let release!: () => void;
    scheduler.stopGate = new Promise(resolve => { release = resolve; });
    const updated = windowsInstall(f.paths, { ...f.spec, port: 47832 });
    await vi.waitFor(() => expect(scheduler.calls.some(call => call.args.at(-1)?.includes("WaitOne"))).toBe(true));
    expect(JSON.parse(fs.readFileSync(path.join(f.paths.home, "windows-runtime.json"), "utf8")).port).toBe(47831);
    expect(scheduler.calls.filter(call => call.args.includes("/Create"))).toHaveLength(1);
    release(); await updated;
    expect(scheduler.tasks.get(taskName(f.paths.home))?.running?.port).toBe(47832);
  });
  it("refuses to overwrite or uninstall if the running host fails to stop", async () => {
    const f = fixture(); await windowsInstall(f.paths, f.spec); scheduler.failStop = true;
    await expect(windowsInstall(f.paths, { ...f.spec, port: 47832 })).rejects.toThrow("did not stop");
    await expect(windowsProductIntegration(f.root, "uninstall")).rejects.toThrow("did not stop");
    expect(scheduler.tasks.get(taskName(f.paths.home))?.running?.port).toBe(47831);
    expect(fs.existsSync(path.join(f.paths.home, "windows-runtime.json"))).toBe(true);
  });
  it("recovers the prior service if updating scheduler registration fails", async () => {
    const f = fixture(); await windowsInstall(f.paths, f.spec); scheduler.failCreate = true;
    await expect(windowsInstall(f.paths, { ...f.spec, port: 47832 })).rejects.toThrow("Registration refused");
    expect(scheduler.tasks.get(taskName(f.paths.home))?.running?.port).toBe(47831);
  });
  it("product uninstall removes its CLI, pointer and managed PATH but preserves task data and other installations", async () => {
    const f = fixture(), other = fixture("other data", "Other install");
    for (const entry of [f, other]) {
      await windowsInstall(entry.paths, entry.spec);
      installWindowsCli(entry.spec.hostPath, path.join(entry.paths.bin, "todocue.exe"), entry.root);
      registerWindowsHome(entry.spec, await ensureWindowsCliPath(entry.paths.bin));
      fs.writeFileSync(entry.paths.database, "keep database");
    }
    await windowsProductIntegration(f.root, "uninstall");
    expect(scheduler.tasks.has(taskName(f.paths.home))).toBe(false);
    expect(fs.existsSync(path.join(f.paths.bin, "todocue.exe"))).toBe(false);
    expect(fs.existsSync(path.join(f.paths.bin, "todocue-runtime-path.txt"))).toBe(false);
    expect(scheduler.userPath).toEqual(["C:\\Other tools", other.paths.bin]);
    expect(fs.readFileSync(f.paths.database, "utf8")).toBe("keep database");
    expect(windowsHomes(f.root)).toEqual([]);
    expect(fs.existsSync(path.join(other.paths.bin, "todocue.exe"))).toBe(true);
    expect(scheduler.tasks.get(taskName(other.paths.home))?.running).toBeTruthy();
    await windowsProductIntegration(f.root, "uninstall"); // idempotent re-entry
  });
  it("service uninstall keeps the CLI, and product cleanup honors a pointer reassigned to another runtime", async () => {
    const f = fixture(); await windowsInstall(f.paths, f.spec);
    const cli = path.join(f.paths.bin, "todocue.exe"), pointer = path.join(f.paths.bin, "todocue-runtime-path.txt");
    installWindowsCli(f.spec.hostPath, cli, f.root); registerWindowsHome(f.spec, await ensureWindowsCliPath(f.paths.bin));
    await windowsUninstall(f.paths);
    expect(fs.existsSync(cli)).toBe(true);
    fs.writeFileSync(pointer, path.join(base, "replacement runtime"));
    await windowsProductIntegration(f.root, "uninstall");
    expect(fs.existsSync(cli)).toBe(true);
    expect(scheduler.userPath).toContain(f.paths.bin);
  });
});
