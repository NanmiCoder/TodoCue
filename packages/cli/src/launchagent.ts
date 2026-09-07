import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { RuntimePaths } from "@todocue/server";

const execFileP = promisify(execFile);

export interface LaunchAgentSpec {
  label: string;
  plistPath: string;
  nodePath: string;
  cliEntry: string;
  home: string;
  logDir: string;
  port?: number;
}

export function renderPlist(spec: LaunchAgentSpec): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const env: Record<string, string> = { TODOCUE_HOME: spec.home, PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin" };
  if (spec.port) env.TODOCUE_PORT = String(spec.port);
  if (process.env.TODOCUE_NOTIFIER) env.TODOCUE_NOTIFIER = process.env.TODOCUE_NOTIFIER;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(spec.nodePath)}</string>
    <string>${esc(spec.cliEntry)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`)
  .join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${esc(path.join(spec.logDir, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(spec.logDir, "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

async function launchctl(args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await execFileP("/bin/launchctl", args, { timeout: 15_000 });
    return { ok: true, out: (stdout + stderr).trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: ((err.stdout ?? "") + (err.stderr ?? "") || err.message).trim() };
  }
}

const domain = () => `gui/${process.getuid?.() ?? 501}`;

export async function installLaunchAgent(paths: RuntimePaths, spec: Omit<LaunchAgentSpec, "label" | "plistPath" | "home" | "logDir">): Promise<string> {
  const full: LaunchAgentSpec = { ...spec, label: paths.launchAgentLabel, plistPath: paths.launchAgentPlist, home: paths.home, logDir: paths.logs };
  fs.mkdirSync(path.dirname(full.plistPath), { recursive: true });
  // Unload any previous version before rewriting.
  await launchctl(["bootout", `${domain()}/${full.label}`]);
  fs.writeFileSync(full.plistPath, renderPlist(full), { mode: 0o644 });
  const res = await launchctl(["bootstrap", domain(), full.plistPath]);
  if (!res.ok && !/already loaded|service already bootstrapped/i.test(res.out)) {
    throw new Error(`launchctl bootstrap failed: ${res.out}`);
  }
  await launchctl(["kickstart", "-k", `${domain()}/${full.label}`]);
  return full.plistPath;
}

export async function uninstallLaunchAgent(paths: RuntimePaths): Promise<boolean> {
  await launchctl(["bootout", `${domain()}/${paths.launchAgentLabel}`]);
  if (fs.existsSync(paths.launchAgentPlist)) {
    fs.unlinkSync(paths.launchAgentPlist);
    return true;
  }
  return false;
}

export async function startLaunchAgent(paths: RuntimePaths): Promise<string> {
  if (!fs.existsSync(paths.launchAgentPlist)) throw new Error("service not installed; run `todocue service install`");
  const boot = await launchctl(["bootstrap", domain(), paths.launchAgentPlist]);
  const kick = await launchctl(["kickstart", `${domain()}/${paths.launchAgentLabel}`]);
  return [boot.out, kick.out].filter(Boolean).join("\n");
}

export async function stopLaunchAgent(paths: RuntimePaths): Promise<string> {
  const res = await launchctl(["bootout", `${domain()}/${paths.launchAgentLabel}`]);
  return res.out;
}

export async function restartLaunchAgent(paths: RuntimePaths): Promise<string> {
  if (!fs.existsSync(paths.launchAgentPlist)) throw new Error("service not installed; run `todocue service install`");
  await launchctl(["bootstrap", domain(), paths.launchAgentPlist]);
  const res = await launchctl(["kickstart", "-k", `${domain()}/${paths.launchAgentLabel}`]);
  return res.out;
}

export async function launchAgentStatus(paths: RuntimePaths): Promise<{ installed: boolean; loaded: boolean; pid: number | null; detail: string }> {
  const installed = fs.existsSync(paths.launchAgentPlist);
  const res = await launchctl(["print", `${domain()}/${paths.launchAgentLabel}`]);
  if (!res.ok) return { installed, loaded: false, pid: null, detail: installed ? "installed but not loaded" : "not installed" };
  const pidMatch = /pid = (\d+)/.exec(res.out);
  const stateMatch = /state = (\w+)/.exec(res.out);
  return {
    installed,
    loaded: true,
    pid: pidMatch ? Number.parseInt(pidMatch[1]!, 10) : null,
    detail: `loaded, state ${stateMatch?.[1] ?? "unknown"}${pidMatch ? `, pid ${pidMatch[1]}` : ""}`,
  };
}
