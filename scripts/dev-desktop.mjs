import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.TODOCUE_HOME ?? path.join(os.tmpdir(), "todocue-desktop-development");
const env = { ...process.env, TODOCUE_HOME: home, TODOCUE_PORT: "47832" };
console.log(`Desktop development data: ${home}\nCLI: TODOCUE_HOME="${home}" npm run todocue -- --json today`);
function run(command, args) { return spawn(command, args, { cwd: root, env, stdio: "inherit" }); }
const build = run(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-b", "tsconfig.build.json"]);
if (await new Promise(resolve => build.on("exit", resolve)) !== 0) process.exit(1);
const runtime = run(process.execPath, ["packages/cli/dist/index.js", "serve"]);
const ui = run(process.execPath, ["node_modules/vite/bin/vite.js", "apps/desktop", "--config", "apps/desktop/vite.config.ts"]);
let stopped = false;
function stop() { if (stopped) return; stopped = true; runtime.kill("SIGTERM"); ui.kill("SIGTERM"); }
process.on("SIGINT", stop); process.on("SIGTERM", stop);
runtime.on("exit", code => { if (!stopped && code) process.exitCode = code; stop(); });
ui.on("exit", code => { if (!stopped && code) process.exitCode = code; stop(); });
