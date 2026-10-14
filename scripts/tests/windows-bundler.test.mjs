import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWindowsBundler } from "../windows-bundler.mjs";

function fixture(t, body) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "todocue-bundler-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const script = path.join(cwd, "bundle.mjs");
  fs.writeFileSync(script, `import fs from "node:fs";
const count = fs.existsSync("attempts") ? Number(fs.readFileSync("attempts", "utf8")) : 0;
fs.writeFileSync("attempts", String(count + 1));
${body}`);
  return { cwd, script, count: () => Number(fs.readFileSync(path.join(cwd, "attempts"), "utf8")) };
}

test("Windows bundler resumes after the observed transient download failure", async t => {
  const f = fixture(t, 'if (count === 0) { console.error("failed to bundle project: `Peer disconnected`"); process.exit(1); } fs.writeFileSync("installer.exe", "complete");');
  await runWindowsBundler(process.execPath, [f.script], { cwd: f.cwd, retryDelayMs: 0 });
  assert.equal(f.count(), 2);
  assert.equal(fs.readFileSync(path.join(f.cwd, "installer.exe"), "utf8"), "complete");
});

test("Windows bundler fails once on deterministic errors even if earlier output names a disconnected peer", async t => {
  const f = fixture(t, 'console.log("Peer disconnected fixture"); console.error("failed to bundle project: checksum mismatch"); process.exit(7);');
  await assert.rejects(runWindowsBundler(process.execPath, [f.script], { cwd: f.cwd, retryDelayMs: 0 }), error => error.code === 7);
  assert.equal(f.count(), 1);
});

test("Windows bundler bounds repeated transport failures and propagates failure", async t => {
  const f = fixture(t, 'console.error("failed to bundle project: `Peer disconnected`"); process.exit(1);');
  await assert.rejects(runWindowsBundler(process.execPath, [f.script], { cwd: f.cwd, retryDelayMs: 0 }), error => error.code === 1);
  assert.equal(f.count(), 3);
  assert.equal(fs.existsSync(path.join(f.cwd, "installer.exe")), false);
});
