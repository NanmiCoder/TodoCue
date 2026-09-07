import fs from "node:fs";
import path from "node:path";
import { appBundle, ensureHome, isRuntimeAlive, packagedHelper, runtimePaths, type RuntimePaths } from "@todocue/server";
import { installLaunchAgent, launchAgentStatus, renderPlist, startLaunchAgent } from "./launchagent.js";

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function cliWrapper(node: string, entry: string): string {
  return `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(entry)} "$@"\n`;
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
