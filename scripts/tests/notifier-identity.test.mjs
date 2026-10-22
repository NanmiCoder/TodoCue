import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tauri = path.join(root, "apps/desktop/src-tauri");
const read = file => fs.readFileSync(path.join(tauri, file), "utf8");

const identifier = JSON.parse(read("tauri.conf.json")).identifier;
const notifier = read("src/bin/notifier.rs");
const hooks = read("windows-hooks.nsh");

// The toast AUMID has to equal the bundle identifier, because the NSIS hook registers the key
// under ${BUNDLEID}. If they drift, Windows silently drops every toast.
test("notifier AUMID constant equals the Tauri identifier", () => {
  const match = notifier.match(/const APP_USER_MODEL_ID: &str = "([^"]+)";/);
  assert.ok(match, "notifier.rs must declare `const APP_USER_MODEL_ID: &str = \"...\";`");
  assert.equal(match[1], identifier);
});

test("notifier does not hard-code the identifier outside the AUMID constant", () => {
  const stray = notifier.split("\n").filter(line => line.includes(identifier) && !line.includes("APP_USER_MODEL_ID: &str"));
  // Doc comments and unit tests may mention it; code must go through the constant.
  const code = stray.filter(line => !/^\s*(\/\/|assert)/.test(line));
  assert.deepEqual(code, []);
});

test("NSIS hook registers the AppUserModelId key under the bundle identifier", () => {
  const keys = [...hooks.matchAll(/HKCU "Software\\Classes\\AppUserModelId\\([^"]+)"/g)].map(m => m[1]);
  assert.ok(keys.length >= 2, "install and uninstall must both touch the AppUserModelId key");
  for (const key of keys) {
    // ${BUNDLEID} is substituted by Tauri's NSIS template from `identifier`; a literal must match.
    assert.ok(key === "${BUNDLEID}" || key === identifier, `unexpected AppUserModelId key: ${key}`);
  }
  assert.match(hooks, /WriteRegStr HKCU "Software\\Classes\\AppUserModelId\\\$\{BUNDLEID\}" "DisplayName" "TodoCue"/);
});

test("NSIS hook never points the toast IconUri at an executable", () => {
  for (const line of hooks.split("\n")) {
    if (/^\s*;/.test(line) || !line.includes("IconUri")) continue;
    assert.match(line, /DeleteRegValue/, `IconUri may only be removed, got: ${line.trim()}`);
  }
});

test("the notifier's self-registered DisplayName matches the installer's", () => {
  const display = notifier.match(/const APP_DISPLAY_NAME: &str = "([^"]+)";/);
  assert.ok(display);
  assert.match(hooks, new RegExp(`"DisplayName" "${display[1]}"`));
});
