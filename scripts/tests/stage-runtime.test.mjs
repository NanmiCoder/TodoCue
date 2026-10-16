import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeWorkspaceLinks, runtimePackages, stageRuntime } from "../stage-runtime.mjs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test("packaged runtime includes the portable client and excludes the desktop workspace", t => {
  const root = path.resolve(import.meta.dirname, "../..");
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "todocue-staged-"));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  stageRuntime(root, destination);
  const pkg = JSON.parse(fs.readFileSync(path.join(destination, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(destination, "package-lock.json"), "utf8"));
  assert.deepEqual(pkg.workspaces, ["packages/*"]);
  assert.equal(lock.packages["apps/desktop"], undefined);
  assert.ok(fs.existsSync(path.join(destination, "packages/client/dist/index.js")));
  // Registry/cache installation is covered in the packaging smoke, not by this layout test.
  assert.equal(lock.packages["packages/server"].dependencies["@todocue/client"], pkg.version);
});

test("workspace entrypoints survive bundling and relocation without changing runtime module URLs", t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "todocue-links-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const staged = path.join(temporary, "staged"), installed = path.join(temporary, "installed with spaces");
  for (const name of runtimePackages) {
    const source = path.join(staged, "packages", name), link = path.join(staged, "node_modules/@todocue", name);
    fs.mkdirSync(path.join(source, "dist"), { recursive: true });
    fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: `@todocue/${name}`, type: "module", exports: "./dist/index.js" }));
    fs.writeFileSync(path.join(source, "dist/index.js"), name === "server"
      ? 'import { fileURLToPath } from "node:url"; import { value } from "@todocue/shared"; export const sharedValue = value; export const runtimeRoot = () => fileURLToPath(new URL("../../../", import.meta.url));\n'
      : `export const value = ${JSON.stringify(name)};\n`);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(source, link, process.platform === "win32" ? "junction" : "dir");
  }
  materializeWorkspaceLinks(staged);
  for (const name of runtimePackages) {
    assert.equal(fs.lstatSync(path.join(staged, "node_modules/@todocue", name)).isSymbolicLink(), false);
    assert.ok(fs.existsSync(path.join(staged, "packages", name, "dist/index.js")), "Removing a junction must not remove its target");
  }
  fs.cpSync(staged, installed, { recursive: true });
  fs.rmSync(staged, { recursive: true, force: true });
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", 'const m=await import(process.env.TODOCUE_TEST_ENTRY); console.log(JSON.stringify({shared:m.sharedValue, root:m.runtimeRoot()}));'], {
    encoding: "utf8", env: { ...process.env, TODOCUE_TEST_ENTRY: pathToFileURL(path.join(installed, "node_modules/@todocue/server/dist/index.js")).href },
  });
  const result = JSON.parse(output);
  assert.equal(result.shared, "shared");
  assert.equal(fs.realpathSync(result.root), fs.realpathSync(installed));
});
