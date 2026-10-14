import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { materializeWorkspaceLinks, stageRuntime } from "./stage-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) throw new Error("Build on a Windows x64 or ARM64 runner");
const arch = process.arch, target = `${arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`;
const nodeVersion = "26.7.0";
const hashes = { arm64: "be8775204cfceca5a73c30f91bf0de5e85274c01b776dc13f16b91aa251ebb01", x64: "d3bd72755141ed32bbcd841228ee81897c8a98d50dfa7dae2179399a0a7c90f8" };
const native = path.join(root, "apps/desktop/src-tauri");
const cache = path.join(native, "target/downloads"); fs.mkdirSync(cache, { recursive: true });
function run(command, args, opts = {}) { execFileSync(command, args, { cwd: root, stdio: "inherit", ...opts }); }
const npm = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
run(process.execPath, [npm, "run", "desktop:build"]);
const distributionName = `node-v${nodeVersion}-win-${arch}`;
const archive = path.join(cache, `${distributionName}.zip`);
if (!fs.existsSync(archive)) {
  const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${distributionName}.zip`);
  if (!response.ok) throw new Error(`Node download failed: ${response.status}`);
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
}
if (createHash("sha256").update(fs.readFileSync(archive)).digest("hex") !== hashes[arch]) throw new Error("Official Node distribution checksum mismatch");
run("tar.exe", ["-xf", archive, "-C", cache]);
const distribution = path.join(cache, distributionName);
const staging = path.join(native, "target/staged");
fs.rmSync(staging, { recursive: true, force: true }); fs.mkdirSync(staging, { recursive: true });
const runtime = path.join(staging, "runtime"); stageRuntime(root, runtime);
fs.mkdirSync(path.join(runtime, "bin")); fs.copyFileSync(path.join(distribution, "node.exe"), path.join(runtime, "bin/node.exe"));
fs.copyFileSync(path.join(distribution, "LICENSE"), path.join(runtime, "NODE-LICENSE"));
run(path.join(distribution, "node.exe"), [path.join(distribution, "node_modules/npm/bin/npm-cli.js"), "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: runtime });
materializeWorkspaceLinks(runtime);
run(path.join(distribution, "node.exe"), [path.join(runtime, "packages/cli/dist/index.js"), "--version"]);
const prebuilds = path.join(runtime, "node_modules/better-sqlite3/prebuilds");
for (const file of fs.readdirSync(prebuilds)) if (file !== `win32-${arch}.node`) fs.rmSync(path.join(prebuilds, file), { force: true, recursive: true });
run(path.join(runtime, "bin/node.exe"), ["--input-type=module", "-e", "import Database from 'better-sqlite3'; const db=new Database(':memory:'); if(db.prepare('select 1 as n').get().n!==1)process.exit(1); db.close();"], { cwd: runtime });
run("cargo", ["build", "--release", "--locked", "--manifest-path", path.join(native, "Cargo.toml"), "--target", target, "--bin", "todocue-cli", "--bin", "todocue-runtime", "--bin", "TodoCueNotifier"]);
const binaries = path.join(staging, "binaries"); fs.mkdirSync(binaries);
for (const name of ["todocue-cli", "todocue-runtime", "TodoCueNotifier"]) fs.copyFileSync(path.join(native, "target", target, "release", `${name}.exe`), path.join(binaries, `${name}-${target}.exe`));
fs.cpSync(path.join(root, "skills/todocue"), path.join(staging, "skills/todocue"), { recursive: true });
const config = {
  bundle: { active: true, targets: ["nsis"], resources: { "target/staged/runtime/": "runtime/", "target/staged/skills/": "skills/" }, externalBin: ["target/staged/binaries/todocue-cli", "target/staged/binaries/todocue-runtime", "target/staged/binaries/TodoCueNotifier"],
    windows: { webviewInstallMode: { type: "offlineInstaller" }, nsis: { installMode: "currentUser", installerHooks: "windows-hooks.nsh", languages: ["English", "SimpChinese"] } } },
};
fs.writeFileSync(path.join(native, "target/windows-config.json"), JSON.stringify(config, null, 2));
run(process.execPath, [npm, "run", "tauri", "--workspace", "@todocue/desktop", "--", "build", "--target", target, "--config", "src-tauri/target/windows-config.json"]);
const output = path.join(native, "target", target, "release", "bundle/nsis");
for (const file of fs.readdirSync(output).filter(file => file.endsWith(".exe"))) {
  fs.writeFileSync(path.join(output, `${file}.sha256`), `${createHash("sha256").update(fs.readFileSync(path.join(output, file))).digest("hex")}  ${file}\n`);
}
console.log(`Windows ${arch} preview installers: ${output}`);
