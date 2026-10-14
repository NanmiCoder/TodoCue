import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createServer } from "node:net";

// Run only on disposable Windows build runners, with a new isolated data directory.
// This exercises the installed package; it never uses the checkout's Node/runtime.
assert.equal(process.platform, "win32", "Windows installation smoke requires Windows");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`;
const bundles = path.join(root, "apps/desktop/src-tauri/target", target, "release/bundle/nsis");
const installers = (await fs.readdir(bundles)).filter(name => name.endsWith(".exe"));
assert.equal(installers.length, 1, "Expected one preview installer");
const installer = path.join(bundles, installers[0]);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "todocue-install-smoke-"));
const app = path.join(temporary, "app");
const home = path.join(temporary, "自定义 data home");
const env = { ...process.env, TODOCUE_HOME: home };
const ordinaryEnv = { ...process.env };
for (const key of Object.keys(ordinaryEnv)) if (key.toUpperCase() === "TODOCUE_HOME") delete ordinaryEnv[key];
const exec = promisify(execFile);
const node = path.join(app, "runtime/bin/node.exe");
const cli = path.join(app, "todocue-cli.exe");
const shim = path.join(home, "bin/todocue.exe");
const uninstaller = path.join(app, "uninstall.exe");
const homeId = createHash("sha256").update(path.resolve(home).toLowerCase()).digest("hex").slice(0, 12);
const taskName = `TodoCue-Runtime-${homeId}`;
assert(process.env.LOCALAPPDATA, "Windows installation smoke needs the current-user local application directory");
const registration = path.join(process.env.LOCALAPPDATA, "TodoCue/homes", `${homeId}.json`);
const manifest = path.join(home, "windows-runtime.json");
let mcp;
let taskDisabled = false;
const report = { architecture: process.arch, installer: installers[0], passed: [] };
const pass = name => { report.passed.push(name); console.log(`PASS ${name}`); };
const run = async (file, args, timeout = 60000, childEnv = env) => (await exec(file, args, { env: childEnv, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 })).stdout;
const command = async (...args) => JSON.parse(await run(cli, ["--home", home, "--json", ...args]));
const ordinaryCommand = async (...args) => JSON.parse(await run(shim, ["--json", ...args], 60000, ordinaryEnv));
const present = async file => { try { await fs.access(file); return true; } catch { return false; } };
const waitForInstalledHealth = async () => {
  const deadline = Date.now() + 15000;
  let status;
  do {
    status = await command("service", "status");
    if (status.launchAgent.loaded) return status;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error(`Installed runtime did not report healthy: ${JSON.stringify(status)}`);
};
const markForRecovery = async () => {
  const value = JSON.parse(await fs.readFile(registration, "utf8"));
  assert.equal(path.resolve(value.home).toLowerCase(), path.resolve(home).toLowerCase());
  assert.equal(path.resolve(value.runtimeRoot).toLowerCase(), path.join(app, "runtime").toLowerCase());
  await fs.writeFile(registration, JSON.stringify({ ...value, resumeAfterUpgrade: true }, null, 2));
};
const expectInstallerFailure = async () => {
  await assert.rejects(run(installer, ["/S", `/D=${app}`], 300000), error => {
    assert.equal(error.killed, false, "Installer hung or timed out instead of reporting failure");
    assert.equal(error.signal, null);
    assert(Number.isInteger(error.code) && error.code > 0, `Expected nonzero installer exit, got ${error.code}`);
    return true;
  });
  assert.equal(JSON.parse(await fs.readFile(registration, "utf8")).resumeAfterUpgrade, true);
  assert(await present(path.join(home, "todocue.sqlite")), "Failed recovery removed the database");
};
try {
  await run(installer, ["/S", `/D=${app}`], 300000);
  for (const name of ["todocue-desktop.exe", "todocue-cli.exe", "todocue-runtime.exe", "TodoCueNotifier.exe", "runtime/bin/node.exe", "runtime/packages/cli/dist/index.js", "skills/todocue/SKILL.md", "uninstall.exe"]) {
    assert(await present(path.join(app, name)), `Installed file missing: ${name}`);
  }
  assert.equal((await run(node, ["-p", "process.arch"])).trim(), process.arch);
  await run(node, ["--input-type=module", "-e", "import {createRequire} from 'node:module'; const require=createRequire(process.argv[1]); const Database=require('better-sqlite3'); const db=new Database(':memory:'); if(db.prepare('select 1 as n').get().n!==1)process.exit(1); db.close();", path.join(app, "runtime/package.json")]);
  pass("silent NSIS install, packaged Node architecture and native SQLite SQL");

  const installed = await command("install", "--skip-notifications");
  assert.equal(installed.running, true);
  assert.equal(path.resolve(installed.cli), shim);
  assert.equal((await fs.readFile(path.join(home, "bin/todocue-runtime-path.txt"), "utf8")).trim(), path.join(app, "runtime"));
  const status = await command("service", "status");
  assert.equal(status.launchAgent.installed, true);
  assert.equal(status.launchAgent.loaded, true);
  pass("custom home bootstrap, current-user scheduled runtime and installed CLI shim");

  const attachment = path.join(temporary, "附件.txt");
  await fs.writeFile(attachment, "installed Windows preview attachment\n", "utf8");
  const created = await command("add", "Windows 安装后回归", "--date", "today", "--attach", attachment, "--idempotency-key", "windows-install-smoke");
  assert.equal(created.task.attachments.length, 1);
  const replay = await command("add", "Windows 安装后回归", "--date", "today", "--attach", attachment, "--idempotency-key", "windows-install-smoke");
  assert.equal(replay.task.id, created.task.id);
  const context = await ordinaryCommand("context");
  assert.equal(context.runtimeVersion, JSON.parse(await fs.readFile(path.join(app, "runtime/package.json"), "utf8")).version);
  const viaShim = await ordinaryCommand("show", created.task.id);
  assert.equal(viaShim.task.title, created.task.title);
  const ordinaryCreated = await ordinaryCommand("add", "Windows 无 home 参数的 CLI 回归", "--date", "today");
  assert.equal((await command("show", ordinaryCreated.task.id)).task.title, ordinaryCreated.task.title);
  pass("packaged CLI and ordinary custom-home shim context/add/read without home flag or environment");

  mcp = spawn(shim, ["mcp"], { env: ordinaryEnv, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  let sequence = 0;
  const lines = createInterface({ input: mcp.stdout });
  lines.on("line", line => {
    const response = JSON.parse(line), waiter = waiting.get(response.id);
    if (!waiter) return;
    waiting.delete(response.id); clearTimeout(waiter.timer);
    response.error ? waiter.reject(new Error(JSON.stringify(response.error))) : waiter.resolve(response.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`MCP timed out: ${method}`)); }, 10000);
    waiting.set(id, { resolve, reject, timer });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "windows-install-smoke", version: "1" } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  assert((await rpc("tools/list", {})).tools.some(tool => tool.name === "todocue_get_task"));
  const result = await rpc("tools/call", { name: "todocue_get_task", arguments: { id: created.task.id } });
  assert(!result.isError, result.content?.[0]?.text);
  assert.equal((result.structuredContent ?? JSON.parse(result.content[0].text)).task.id, created.task.id);
  mcp.stdin.end();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Installed MCP did not close after stdin EOF")), 10000);
    mcp.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Installed MCP exited ${code}`)); });
    mcp.once("error", error => { clearTimeout(timer); reject(error); });
  });
  mcp = undefined;
  pass("ordinary installed MCP without home flag/environment initializes, discovers and reads its task");

  assert.equal((await command("service", "stop")).running, false);
  assert.equal((await command("service", "start")).running, true);
  assert.equal((await command("show", created.task.id)).task.attachments.length, 1);
  pass("background stop/start preserves SQLite task and attachment");

  // Select an unused non-default port, then exercise the same bootstrap called by the GUI.
  const portProbe = createServer();
  await new Promise((resolve, reject) => { portProbe.once("error", reject); portProbe.listen(0, "127.0.0.1", resolve); });
  const selectedPort = portProbe.address().port;
  await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
  assert.notEqual(selectedPort, 47831, "Test port unexpectedly equals the default runtime port");
  assert.equal((await command("service", "install", "--port", String(selectedPort))).running, true);
  assert.equal(JSON.parse(await fs.readFile(manifest, "utf8")).port, selectedPort);
  assert.equal((await command("bootstrap")).running, true);
  assert.equal(JSON.parse(await fs.readFile(manifest, "utf8")).port, selectedPort);
  assert.equal(Number(new URL(JSON.parse(await fs.readFile(path.join(home, "connection.json"), "utf8")).baseUrl).port), selectedPort);
  assert.equal((await ordinaryCommand("show", created.task.id)).task.id, created.task.id);
  pass("GUI runtime bootstrap retains the existing non-default port and installed shim connection");

  // Reinstall the same preview to exercise the installer maintenance hooks.
  await run(installer, ["/S", `/D=${app}`], 300000);
  // /Run acknowledges scheduling before the host/Node health endpoint is ready.
  // Poll without starting it ourselves, so a broken installer resume hook still fails.
  const afterUpgrade = await waitForInstalledHealth();
  assert.equal(afterUpgrade.launchAgent.installed, true);
  assert.equal(afterUpgrade.launchAgent.loaded, true);
  assert.equal((await command("show", created.task.id)).task.id, created.task.id);
  assert.equal(JSON.parse(await fs.readFile(manifest, "utf8")).port, selectedPort);
  pass("silent reinstall stops and resumes the registered custom-home runtime");

  // Fault injection is confined to the registered task and home created above.
  assert.equal((await command("service", "stop")).running, false);
  const databaseBeforeFailure = await fs.readFile(path.join(home, "todocue.sqlite"));
  await markForRecovery();
  await run("schtasks.exe", ["/Change", "/TN", taskName, "/DISABLE"]); taskDisabled = true;
  await expectInstallerFailure();
  assert.deepEqual(await fs.readFile(path.join(home, "todocue.sqlite")), databaseBeforeFailure);
  await run("schtasks.exe", ["/Change", "/TN", taskName, "/ENABLE"]); taskDisabled = false;
  await run(installer, ["/S", `/D=${app}`], 300000);
  await waitForInstalledHealth();
  assert.equal(JSON.parse(await fs.readFile(registration, "utf8")).resumeAfterUpgrade, false);
  assert.equal((await ordinaryCommand("show", created.task.id)).task.id, created.task.id);
  pass("disabled scheduled task makes installer fail nonzero, retaining data/recovery state for successful retry");

  // /Run may succeed even when the supervisor cannot start Node. Health must be
  // confirmed before clearing recovery state or declaring installation success.
  assert.equal((await command("service", "stop")).running, false);
  const databaseBeforeUnhealthyRestart = await fs.readFile(path.join(home, "todocue.sqlite"));
  const originalManifest = await fs.readFile(manifest, "utf8");
  const unhealthySpec = JSON.parse(originalManifest);
  unhealthySpec.nodePath = path.join(home, "missing-node-for-install-smoke.exe");
  await fs.writeFile(manifest, JSON.stringify(unhealthySpec, null, 2));
  await markForRecovery();
  await expectInstallerFailure();
  assert.deepEqual(await fs.readFile(path.join(home, "todocue.sqlite")), databaseBeforeUnhealthyRestart);
  await fs.writeFile(manifest, originalManifest);
  await run(installer, ["/S", `/D=${app}`], 300000);
  await waitForInstalledHealth();
  assert.equal(JSON.parse(await fs.readFile(registration, "utf8")).resumeAfterUpgrade, false);
  assert.equal((await ordinaryCommand("show", ordinaryCreated.task.id)).task.id, ordinaryCreated.task.id);
  pass("acknowledged but unhealthy restart fails installation and keeps recovery until a healthy retry");

  await run(uninstaller, ["/S"], 180000);
  const until = Date.now() + 10000;
  while (await present(cli) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await present(cli), false, "Installer files remain after uninstall");
  assert.equal(await present(shim), false, "Managed CLI shim remains after uninstall");
  assert.equal(await present(path.join(home, "windows-runtime.json")), false, "Service manifest remains after uninstall");
  assert.equal(await present(path.join(home, "todocue.sqlite")), true, "Uninstall removed the database");
  const userPath = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')"]);
  assert(!userPath.split(";").some(entry => path.resolve(entry.trim() || ".").toLowerCase() === path.join(home, "bin").toLowerCase()), "Managed PATH remains after uninstall");
  pass("uninstall removes service, CLI and PATH while preserving the database");
} finally {
  mcp?.stdin.end(); mcp?.kill();
  if (taskDisabled) await run("schtasks.exe", ["/Change", "/TN", taskName, "/ENABLE"]).catch(error => console.error("Cleanup enable task:", error.message));
  if (await present(uninstaller)) await run(uninstaller, ["/S"], 180000).catch(error => console.error("Cleanup uninstall:", error.message));
  const output = process.env.TODOCUE_INSTALL_SMOKE_REPORT;
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2));
  // Leave failure data on the disposable runner for diagnostics; it is never a personal home.
  console.log(`Windows installation smoke: ${report.passed.length} checks; isolated data ${home}`);
}
