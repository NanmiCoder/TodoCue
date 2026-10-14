import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

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
const exec = promisify(execFile);
const node = path.join(app, "runtime/bin/node.exe");
const cli = path.join(app, "todocue-cli.exe");
const shim = path.join(home, "bin/todocue.exe");
const uninstaller = path.join(app, "uninstall.exe");
let mcp;
const report = { architecture: process.arch, installer: installers[0], passed: [] };
const pass = name => { report.passed.push(name); console.log(`PASS ${name}`); };
const run = async (file, args, timeout = 60000) => (await exec(file, args, { env, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 })).stdout;
const command = async (...args) => JSON.parse(await run(cli, ["--home", home, "--json", ...args]));
const present = async file => { try { await fs.access(file); return true; } catch { return false; } };
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
  const viaShim = JSON.parse(await run(shim, ["--home", home, "--json", "show", created.task.id]));
  assert.equal(viaShim.task.title, created.task.title);
  pass("packaged CLI and shim create/read attachment and idempotent retry");

  mcp = spawn(shim, ["--home", home, "mcp"], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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
  pass("installed MCP stdio initialize, discovery and task read");

  assert.equal((await command("service", "stop")).running, false);
  assert.equal((await command("service", "start")).running, true);
  assert.equal((await command("show", created.task.id)).task.attachments.length, 1);
  pass("background stop/start preserves SQLite task and attachment");

  // Reinstall the same preview to exercise the installer maintenance hooks.
  await run(installer, ["/S", `/D=${app}`], 300000);
  // /Run acknowledges scheduling before the host/Node health endpoint is ready.
  // Poll without starting it ourselves, so a broken installer resume hook still fails.
  const readyBy = Date.now() + 15000;
  let afterUpgrade;
  do {
    afterUpgrade = await command("service", "status");
    if (afterUpgrade.launchAgent.loaded) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < readyBy);
  assert.equal(afterUpgrade.launchAgent.installed, true);
  assert.equal(afterUpgrade.launchAgent.loaded, true);
  assert.equal((await command("show", created.task.id)).task.id, created.task.id);
  pass("silent reinstall stops and resumes the registered custom-home runtime");

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
  if (await present(uninstaller)) await run(uninstaller, ["/S"], 180000).catch(error => console.error("Cleanup uninstall:", error.message));
  const output = process.env.TODOCUE_INSTALL_SMOKE_REPORT;
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2));
  // Leave failure data on the disposable runner for diagnostics; it is never a personal home.
  console.log(`Windows installation smoke: ${report.passed.length} checks; isolated data ${home}`);
}
