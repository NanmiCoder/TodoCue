import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isRuntimeAlive, runtimePaths, type RuntimePaths } from "@todocue/server";
import { windowsHomeId, registerWindowsHome, specRuntimeRoot, sameWindowsPath, windowsHomes, saveWindowsHome, forgetWindowsHome } from "./windows-integration.js";
const exec = promisify(execFile);
export interface WindowsRuntimeSpec { home: string; nodePath: string; cliEntry: string; hostPath: string; notifierPath: string; port?: number; }
export function taskName(home: string) { return `TodoCue-Runtime-${windowsHomeId(home)}`; }
export function windowsQuote(value: string): string { return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'; }
export async function ensureWindowsCliPath(bin: string): Promise<boolean> {
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$bin=$env:TODOCUE_INSTALL_BIN; $current=[Environment]::GetEnvironmentVariable('Path','User'); $entries=@($current -split ';' | Where-Object { $_ }); if (-not ($entries | Where-Object { $_.TrimEnd([char]92) -ieq $bin.TrimEnd([char]92) })) { [Environment]::SetEnvironmentVariable('Path', (($entries + $bin) -join ';'), 'User'); 'added' } else { 'existing' }"],
    { windowsHide: true, env: { ...process.env, TODOCUE_INSTALL_BIN: bin } });
  return stdout.trim() === "added";
}
export function taskXml(spec: WindowsRuntimeSpec, sid: string): string {
  if (!/^S-1-(\d+-)+\d+$/.test(sid)) throw new Error("Invalid Windows user SID");
  const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>TodoCue local reminder runtime</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger></Triggers><Principals><Principal id="User"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="User"><Exec><Command>${xml(spec.hostPath)}</Command><Arguments>--home ${xml(windowsQuote(spec.home))}</Arguments></Exec></Actions></Task>`;
}
export async function windowsInstall(paths: RuntimePaths, spec: WindowsRuntimeSpec): Promise<string> {
  for (const file of [spec.nodePath, spec.cliEntry, spec.hostPath, spec.notifierPath]) if (!fs.existsSync(file)) throw new Error(`Packaged runtime file missing: ${file}`);
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { windowsHide: true });
  const sid = stdout.trim();
  fs.mkdirSync(paths.home, { recursive: true });
  await exec("icacls.exe", [paths.home, "/inheritance:r", "/grant:r", `${sid}:(OI)(CI)F`], { windowsHide: true });
  const file = path.join(paths.home, "runtime-task.xml");
  fs.writeFileSync(file, "\uFEFF" + taskXml(spec, sid), "utf16le");
  const registered = await taskRegistered(paths);
  if (registered) await windowsStop(paths);
  // A manually started runtime is not ours to terminate or replace.
  if (await isRuntimeAlive(paths)) throw new Error("Another runtime is using this data directory; stop it before installing the service");
  try {
    await exec("schtasks.exe", ["/Create", "/TN", taskName(paths.home), "/XML", file, "/F"], { windowsHide: true });
  } catch (error) {
    if (registered) await windowsStart(paths).catch(() => {});
    throw error;
  }
  // The manifest is the installation stamp: never commit it after a failed registration.
  fs.writeFileSync(path.join(paths.home, "windows-runtime.json"), JSON.stringify(spec, null, 2));
  registerWindowsHome(spec);
  await windowsStart(paths); return file;
}
export async function windowsStart(paths: RuntimePaths) { const { stdout } = await exec("schtasks.exe", ["/Run", "/TN", taskName(paths.home)], { windowsHide: true }); return stdout.trim(); }
async function taskRegistered(paths: RuntimePaths) {
  try { await exec("schtasks.exe", ["/Query", "/TN", taskName(paths.home)], { windowsHide: true }); return true; } catch { return false; }
}
async function taskRunning(paths: RuntimePaths) {
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$s=New-Object -ComObject Schedule.Service; $s.Connect(); $s.GetFolder('\\').GetTask($env:TODOCUE_TASK_NAME).State"],
    { windowsHide: true, env: { ...process.env, TODOCUE_TASK_NAME: taskName(paths.home) } });
  return stdout.trim() === "4";
}
export async function windowsStop(paths: RuntimePaths) {
  if (!await taskRegistered(paths)) return "Task not installed";
  if (await taskRunning(paths)) await exec("schtasks.exe", ["/End", "/TN", taskName(paths.home)], { windowsHide: true });
  // /End is asynchronous. Wait for both the scheduler and the host mutex: the
  // latter stays held until its kill-on-close job has also terminated Node.
  await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); $t=$s.GetFolder('\\').GetTask($env:TODOCUE_TASK_NAME); $m=[Threading.Mutex]::new($false, ('Local\\TodoCue-'+$env:TODOCUE_TASK_NAME)); try { $until=[DateTime]::UtcNow.AddSeconds(10); do { $free=$false; try { $free=$m.WaitOne(0) } catch [Threading.AbandonedMutexException] { $free=$true }; if ($free) { $m.ReleaseMutex() }; if ($t.State -ne 4 -and $free) { exit 0 }; Start-Sleep -Milliseconds 50 } while ([DateTime]::UtcNow -lt $until); throw 'TodoCue runtime did not stop' } finally { $m.Dispose() }"],
    { windowsHide: true, timeout: 12000, env: { ...process.env, TODOCUE_TASK_NAME: taskName(paths.home) } });
  return "Runtime stopped";
}
export async function windowsRestart(paths: RuntimePaths) { await windowsStop(paths); return windowsStart(paths); }
export async function windowsUninstall(paths: RuntimePaths) {
  const registered = await taskRegistered(paths);
  if (registered) {
    await windowsStop(paths);
    await exec("schtasks.exe", ["/Delete", "/TN", taskName(paths.home), "/F"], { windowsHide: true });
  }
  fs.rmSync(path.join(paths.home, "windows-runtime.json"), { force: true });
  return registered;
}

/** Installer actions discover all owned homes without inheriting TODOCUE_HOME. */
export async function windowsProductIntegration(root: string, action: "stop" | "start" | "uninstall") {
  for (const value of windowsHomes(root)) {
    const paths = runtimePaths(value.home), manifest = path.join(paths.home, "windows-runtime.json");
    let owned = false;
    try { const spec = JSON.parse(fs.readFileSync(manifest, "utf8")) as WindowsRuntimeSpec;
      owned = sameWindowsPath(spec.home, value.home) && sameWindowsPath(specRuntimeRoot(spec), root);
    } catch { /* An installation can have a CLI but no registered service. */ }
    if (action === "stop" && owned) {
      const resumeAfterUpgrade = value.resumeAfterUpgrade || await taskRegistered(paths) && await taskRunning(paths);
      saveWindowsHome({ ...value, resumeAfterUpgrade });
      await windowsStop(paths);
    } else if (action === "start" && owned && value.resumeAfterUpgrade) {
      await windowsStart(paths);
      saveWindowsHome({ ...value, resumeAfterUpgrade: false });
    } else if (action === "uninstall") {
      if (owned) await windowsUninstall(paths);
      await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$key='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; $name=$env:TODOCUE_START_NAME; $value=(Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).$name; if ($value -and $value.StartsWith(('\"'+$env:TODOCUE_START_APP+'\"'),[StringComparison]::OrdinalIgnoreCase)) { Remove-ItemProperty -LiteralPath $key -Name $name; $approved='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'; Remove-ItemProperty -LiteralPath $approved -Name $name -ErrorAction SilentlyContinue }"],
        { windowsHide: true, env: { ...process.env, TODOCUE_START_NAME: `TodoCue Preview ${value.id}`, TODOCUE_START_APP: path.join(path.dirname(root), "todocue-desktop.exe") } });
      const pointer = path.join(paths.bin, "todocue-runtime-path.txt");
      if (fs.existsSync(pointer) && sameWindowsPath(fs.readFileSync(pointer, "utf8").trim(), root)) {
        fs.rmSync(path.join(paths.bin, "todocue.exe"), { force: true });
        fs.rmSync(pointer, { force: true });
        if (value.cliPathManaged) await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
          "$bin=$env:TODOCUE_INSTALL_BIN; $entries=@([Environment]::GetEnvironmentVariable('Path','User') -split ';' | Where-Object { $_ -and $_.TrimEnd([char]92) -ine $bin.TrimEnd([char]92) }); [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')"],
          { windowsHide: true, env: { ...process.env, TODOCUE_INSTALL_BIN: paths.bin } });
      }
      forgetWindowsHome(value);
    }
  }
}
export async function windowsStatus(paths: RuntimePaths) {
  let registered = false;
  try { await exec("schtasks.exe", ["/Query", "/TN", taskName(paths.home)], { windowsHide: true }); registered = true; } catch { /* Removed or never registered. */ }
  const installed = registered && fs.existsSync(path.join(paths.home, "windows-runtime.json")); const alive = await isRuntimeAlive(paths);
  return { installed, loaded: !!alive, pid: alive?.pid ?? null, detail: installed ? alive ? "Windows user task running" : "Windows user task installed; runtime offline" : "Windows user task not installed" };
}
export function windowsSpec(paths: RuntimePaths, spec: { nodePath: string; cliEntry: string; port?: number; notifierPath?: string }): WindowsRuntimeSpec {
  const runtime = path.resolve(spec.cliEntry, "../../../.."); const root = path.dirname(runtime);
  return { ...spec, home: paths.home, hostPath: path.join(root, "todocue-runtime.exe"), notifierPath: spec.notifierPath ?? path.join(root, "TodoCueNotifier.exe") };
}
