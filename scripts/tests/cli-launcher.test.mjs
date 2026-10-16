import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const rustAvailable = spawnSync("rustc", ["--version"], { windowsHide: true }).status === 0;

test("installed native CLI keeps its home and respects explicit overrides and stdio", { skip: !rustAvailable && "rustc is unavailable; native launcher test requires Rust" }, async t => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "todocue-cli-launcher-")));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, "所属 home");
  const app = path.join(temporary, "installed app");
  const runtime = path.join(app, "runtime");
  const profile = path.join(temporary, "empty user profile");
  const override = path.join(temporary, "explicit home");
  for (const dir of [path.join(home, "bin"), path.join(runtime, "bin"), path.join(runtime, "packages/cli/dist"), profile]) fs.mkdirSync(dir, { recursive: true });
  const node = path.join(runtime, "bin", process.platform === "win32" ? "node.exe" : "node");
  if (process.platform === "win32") fs.copyFileSync(process.execPath, node);
  else fs.symlinkSync(process.execPath, node);
  fs.writeFileSync(path.join(runtime, "package.json"), '{"type":"module"}');
  const config = pathToFileURL(path.join(root, "packages/server/dist/config.js")).href;
  const commander = pathToFileURL(createRequire(import.meta.url).resolve("commander")).href;
  // Exercise the real CLI option parser and home resolver, without opening any database.
  fs.writeFileSync(path.join(runtime, "packages/cli/dist/index.js"), `
const { resolveHome } = await import(${JSON.stringify(config)});
const { Command } = await import(${JSON.stringify(commander)});
const program = new Command().option("--home <dir>");
program.command("context").action(() => console.log(JSON.stringify({ home: resolveHome(program.opts().home) })));
program.command("mcp").action(() => process.stdin.pipe(process.stdout));
program.command("failure").action(() => { process.stderr.write("launcher stderr"); process.exitCode = 7; });
program.parse(process.argv);
`);
  const shim = path.join(home, "bin", process.platform === "win32" ? "todocue.exe" : "todocue");
  execFileSync("rustc", [path.join(root, "apps/desktop/src-tauri/src/bin/cli.rs"), "-o", shim], { windowsHide: true, timeout: 60000 });
  fs.writeFileSync(path.join(home, "bin/todocue-runtime-path.txt"), runtime);
  const environment = { ...process.env, HOME: profile, USERPROFILE: profile };
  delete environment.TODOCUE_HOME;
  const readHome = (file, args, env = environment) => JSON.parse(execFileSync(file, args, { cwd: temporary, env, encoding: "utf8", windowsHide: true, timeout: 10000 })).home;
  await t.test("shim supplies its own home without shell environment or CLI flag", () => assert.equal(readHome(shim, ["context"]), home));
  await t.test("existing environment overrides the shim fallback", () => assert.equal(readHome(shim, ["context"], { ...environment, TODOCUE_HOME: override }), override));
  await t.test("space-form home flag overrides the environment", () => assert.equal(readHome(shim, ["--home", home, "context"], { ...environment, TODOCUE_HOME: override }), home));
  await t.test("equals-form home flag overrides the environment", () => assert.equal(readHome(shim, [`--home=${home}`, "context"], { ...environment, TODOCUE_HOME: override }), home));
  await t.test("home flag after the command remains authoritative", () => assert.equal(readHome(shim, ["context", `--home=${override}`]), override));
  await t.test("empty environment retains the existing current-directory meaning", () => assert.equal(readHome(shim, ["context"], { ...environment, TODOCUE_HOME: "" }), temporary));
  await t.test("direct package launcher keeps normal home defaults", () => {
    const packaged = path.join(app, path.basename(shim));
    fs.copyFileSync(shim, packaged); fs.chmodSync(packaged, 0o755);
    // Windows os.homedir uses WindowsIdentity rather than HOME on some versions;
    // compare the resolver in a sibling Node process with exactly the same environment.
    const expected = execFileSync(process.execPath, ["--input-type=module", "-e", `const { resolveHome } = await import(${JSON.stringify(config)}); console.log(resolveHome());`], { env: environment, encoding: "utf8", windowsHide: true }).trim();
    assert.equal(readHome(packaged, ["context"]), expected);
  });
  await t.test("MCP stdio data and stdin EOF pass through unchanged", () => {
    const input = '{"jsonrpc":"2.0","id":1}\n';
    assert.equal(execFileSync(shim, ["mcp"], { env: environment, encoding: "utf8", input, windowsHide: true, timeout: 10000 }), input);
  });
  await t.test("stderr and nonzero child exit status pass through unchanged", () => {
    const result = spawnSync(shim, ["failure"], { env: environment, encoding: "utf8", windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 7); assert.equal(result.stderr, "launcher stderr");
  });
});
