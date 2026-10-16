import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";

// This installs a LaunchAgent. Restrict it to disposable CI users, never a developer's service.
assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Use only a disposable GitHub macOS runner");
assert(process.env.RUNNER_TEMP);
const temporary = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "todocue-installed-"));
const app = path.join(temporary, "TodoCue.app");
execFileSync("/usr/bin/ditto", [process.env.TODOCUE_MACOS_APP, app]);
const home = path.join(temporary, "隔离 data home");
const runtime = path.join(app, "Contents/Resources/runtime");
const node = path.join(runtime, "bin/node");
const entry = path.join(runtime, "packages/cli/dist/index.js");
const env = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
delete env.TODOCUE_HOME;
delete env.TODOCUE_PORT;
const run = (file, args) => execFileSync(file, args, { env, encoding: "utf8", timeout: 60000 });
const cli = (...args) => JSON.parse(run(node, [entry, "--home", home, "--json", ...args]));
try {
  assert.equal(run(node, ["-p", "process.arch"]).trim(), process.arch);
  const build = JSON.parse(fs.readFileSync(path.join(runtime, "BUILD.json"), "utf8"));
  assert.equal(build.client, "shared-tauri");
  assert.equal(build.source, process.env.GITHUB_SHA);
  assert.equal(cli("bootstrap").running, true);
  const attachment = path.join(temporary, "attachment.txt");
  fs.writeFileSync(attachment, "standalone shared runtime\n");
  const created = cli("add", "Mac standalone release check", "--date", "today", "--attach", attachment, "--idempotency-key", "mac-install-smoke");
  assert.equal(created.task.attachments.length, 1);
  assert.equal(cli("add", "Mac standalone release check", "--date", "today", "--attach", attachment, "--idempotency-key", "mac-install-smoke").task.id, created.task.id);
  const shim = path.join(home, "bin/todocue");
  assert.equal(JSON.parse(run(shim, ["--json", "show", created.task.id])).task.id, created.task.id);
  assert.equal(cli("service", "stop").running, false);
  assert.equal(cli("service", "start").running, true);
  assert.equal(cli("show", created.task.id).task.attachments.length, 1);
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  assert.equal(cli("service", "install", "--port", String(port)).running, true);
  assert.equal(cli("bootstrap").running, true);
  assert.equal(new URL(JSON.parse(fs.readFileSync(path.join(home, "connection.json"), "utf8")).baseUrl).port, String(port));
  assert.equal(cli("show", created.task.id).task.id, created.task.id);
  assert.equal(cli("service", "uninstall").removed, true);
  const shutdown = Date.now() + 5000;
  while (cli("service", "status").runtime && Date.now() < shutdown) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(cli("service", "status").runtime, null);
  assert(fs.existsSync(path.join(home, "todocue.sqlite")));
  console.log("PASS packaged native Node/SQLite, bootstrap, ordinary CLI, idempotency, attachments, restart, non-default port, uninstall keeps data");
} finally {
  try { cli("service", "uninstall"); } catch { /* Keep the original failure. */ }
  fs.rmSync(temporary, { recursive: true, force: true });
}
