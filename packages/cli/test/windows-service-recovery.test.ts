import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureHome, runtimePaths } from "@todocue/server";
const commands = vi.hoisted(() => ({ calls: [] as string[][], failCreate: true, registered: false }));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const execFile = Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: async (command: string, args: string[]) => {
    commands.calls.push([command, ...args]);
    if (command === "powershell.exe") return { stdout: "S-1-5-21-123-456-1001\n", stderr: "" };
    if (command === "icacls.exe" && !args.at(-1)?.startsWith("*S-1-")) throw new Error("No mapping between account names and security IDs was done");
    if (command === "schtasks.exe" && args.includes("/Create")) { if (commands.failCreate) throw new Error("Registration refused"); commands.registered = true; }
    if (command === "schtasks.exe" && args.includes("/Query") && !commands.registered) throw new Error("Task missing");
    return { stdout: "Success", stderr: "" };
  } });
  return { ...original, execFile };
});
import { windowsInstall, windowsStatus } from "../src/windows-service.js";
import { installWindowsCli } from "../src/bootstrap.js";
const roots: string[] = [];
function temporary() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todocue-win-test-")); roots.push(dir); return dir; }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); commands.calls = []; commands.failCreate = true; commands.registered = false; });
describe("Windows installation recovery", () => {
  it("does not stamp a failed registration and can install on the next attempt", async () => {
    vi.stubEnv("LOCALAPPDATA", temporary());
    const paths = runtimePaths(temporary()); ensureHome(paths);
    const files = ["node.exe", "index.js", "host.exe", "notifier.exe"].map(name => { const file = path.join(paths.home, name); fs.writeFileSync(file, "fixture"); return file; });
    const spec = { home: paths.home, nodePath: files[0]!, cliEntry: files[1]!, hostPath: files[2]!, notifierPath: files[3]! };
    await expect(windowsInstall(paths, spec)).rejects.toThrow("Registration refused");
    expect(fs.existsSync(path.join(paths.home, "windows-runtime.json"))).toBe(false);
    commands.failCreate = false; await windowsInstall(paths, spec);
    expect((await windowsStatus(paths)).installed).toBe(true);
    commands.registered = false; expect((await windowsStatus(paths)).installed).toBe(false);
    expect(commands.calls.filter(call => call.includes("/Create"))).toHaveLength(2);
    expect(commands.calls.find(call => call[0] === "icacls.exe")?.at(-1)).toBe("*S-1-5-21-123-456-1001:(OI)(CI)F");
  });
  it("keeps an in-use shim and updates its runtime pointer, while identical shims need no copy", () => {
    const dir = temporary(), packaged = path.join(dir, "packaged.exe"), cli = path.join(dir, "todocue.exe");
    fs.writeFileSync(packaged, "new launcher"); fs.writeFileSync(cli, "old launcher");
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("In use"), { code: "EPERM" }); });
    expect(installWindowsCli(packaged, cli, "C:\\New Runtime")).toBe(cli);
    expect(fs.readFileSync(cli, "utf8")).toBe("old launcher");
    expect(fs.readFileSync(path.join(dir, "todocue-runtime-path.txt"), "utf8")).toBe("C:\\New Runtime");
    expect(fs.readdirSync(dir).some(name => name.endsWith(".tmp"))).toBe(false);
    fs.writeFileSync(cli, "new launcher"); rename.mockClear(); installWindowsCli(packaged, cli, "C:\\New Runtime"); expect(rename).not.toHaveBeenCalled();
  });
});
