import fs from "node:fs";
import path from "node:path";
import { appBundle, ensureHome, isRuntimeAlive, packagedHelper, runtimePaths, type RuntimePaths } from "@todocue/server";
import { installLaunchAgent, launchAgentStatus, renderPlist, startLaunchAgent } from "./launchagent.js";
import { windowsInstall, windowsSpec, windowsStatus, windowsStart, ensureWindowsCliPath } from "./windows-service.js";
import { runtimeRoot } from "@todocue/server";
import { registerWindowsHome } from "./windows-integration.js";

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function cliWrapper(node: string, entry: string): string {
  return `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(entry)} "$@"\n`;
}

/** Keep an in-use Windows launcher usable; its runtime pointer can still be updated. */
export function installWindowsCli(packaged: string, target: string, root: string): string {
  if (!fs.existsSync(packaged)) throw new Error("Packaged Windows CLI is missing");
  const source = fs.readFileSync(packaged);
  if (!fs.existsSync(target) || !source.equals(fs.readFileSync(target))) {
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, source);
    try { fs.renameSync(temporary, target); }
    catch (error) {
      fs.rmSync(temporary, { force: true });
      if (!fs.existsSync(target) || !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // Windows prevents replacing a running exe. Existing shims share this pointer contract;
      // the next app launch, after this CLI exits, installs the newer launcher.
    }
  }
  fs.writeFileSync(path.join(path.dirname(target), "todocue-runtime-path.txt"), root);
  return target;
}

/** Keep a home's selected port while updating the installed runtime paths. */
export function installedWindowsPort(home: string): number | undefined {
  try {
    const { port } = JSON.parse(fs.readFileSync(path.join(home, "windows-runtime.json"), "utf8"));
    return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : undefined;
  } catch { return undefined; }
}

/** Install only our wrapper; never replace an unrelated command or symlink. */
export function installCliWrapper(paths: RuntimePaths, node: string, entry: string, linkDirs = ["/opt/homebrew/bin", "/usr/local/bin"]): string {
  const wrapper = path.join(paths.bin, "todocue");
  fs.writeFileSync(wrapper, cliWrapper(node, entry), { mode: 0o755 });
  fs.chmodSync(wrapper, 0o755);
  for (const dir of linkDirs) {
    const link = path.join(dir, "todocue");
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      try {
        const stat = fs.lstatSync(link);
        if (stat.isSymbolicLink() && path.resolve(dir, fs.readlinkSync(link)) === wrapper) return link;
        continue;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
      fs.symlinkSync(wrapper, link);
      return link;
    } catch { /* A user-local wrapper is sufficient when PATH directories aren't writable. */ }
  }
  return wrapper;
}

export async function bootstrapRuntime(home: string): Promise<{ running: boolean; cli: string; app: string }> {
  if (process.platform === "win32") {
    const paths = runtimePaths(home); ensureHome(paths);
    const root = runtimeRoot(); const app = path.dirname(root);
    const spec = windowsSpec(paths, { nodePath: path.join(root, "bin", "node.exe"), cliEntry: path.join(root, "packages", "cli", "dist", "index.js"), port: installedWindowsPort(home) });
    const cli = path.join(paths.bin, "todocue.exe");
    const packagedCli = path.join(app, "todocue-cli.exe");
    // The shim retains the installed runtime path separately, so it works from the user bin.
    installWindowsCli(packagedCli, cli, root);
    const cliPathManaged = await ensureWindowsCliPath(paths.bin);
    registerWindowsHome(spec, cliPathManaged);
    const previous = fs.existsSync(path.join(home, "windows-runtime.json")) ? fs.readFileSync(path.join(home, "windows-runtime.json"), "utf8") : "";
    const status = await windowsStatus(paths);
    if (previous !== JSON.stringify(spec, null, 2) || !status.installed) await windowsInstall(paths, spec);
    else if (!status.loaded) await windowsStart(paths);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await isRuntimeAlive(paths)) return { running: true, cli, app }; await new Promise(resolve => setTimeout(resolve, 250)); }
    throw new Error(`Windows runtime did not start; see ${paths.logs}`);
  }
  const app = appBundle();
  if (!app) throw new Error("Automatic runtime setup requires the packaged TodoCue.app");
  if (app.startsWith("/Volumes/") || app.includes("/AppTranslocation/")) {
    throw new Error("请先将 TodoCue 拖入 Applications，再从 Applications 打开。");
  }
  const paths = runtimePaths(home);
  ensureHome(paths);
  const root = path.join(app, "Contents", "Resources", "runtime");
  const nodePath = path.join(root, "bin", "node");
  const cliEntry = path.join(root, "packages", "cli", "dist", "index.js");
  const helper = packagedHelper(app);
  if (!helper) throw new Error("通知辅助程序缺失，请重新安装 TodoCue。");
  const cli = installCliWrapper(paths, nodePath, cliEntry);
  const stampPath = path.join(home, "runtime-install.json");
  const stamp = JSON.stringify({ app, build: JSON.parse(fs.readFileSync(path.join(root, "BUILD.json"), "utf8")) });
  const previousStamp = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, "utf8") : null;
  const spec = { nodePath, cliEntry, notifierPath: helper };
  const desired = renderPlist({ ...spec, home, logDir: paths.logs, label: paths.launchAgentLabel, plistPath: paths.launchAgentPlist });
  const current = fs.existsSync(paths.launchAgentPlist) ? fs.readFileSync(paths.launchAgentPlist, "utf8") : null;
  const status = await launchAgentStatus(paths);
  const alive = await isRuntimeAlive(paths);
  if (alive && alive.pid !== status.pid) {
    throw new Error("另一个 TodoCue 开发运行时正在使用数据目录，请先停止它再重新打开 App。");
  }
  if (current !== desired || previousStamp !== stamp) await installLaunchAgent(paths, spec);
  else if (!alive) await startLaunchAgent(paths);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await isRuntimeAlive(paths)) {
      fs.writeFileSync(stampPath, stamp, { mode: 0o600 });
      return { running: true, cli, app };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`后台服务启动失败，请查看 ${paths.logs}`);
}
