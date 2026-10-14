import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageRuntime } from "../stage-runtime.mjs";

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
