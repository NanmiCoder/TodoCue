import * as mac from "./launchagent.js";
import * as windows from "./windows-service.js";
import type { RuntimePaths } from "@todocue/server";
export const serviceLabel = process.platform === "win32" ? "Windows user task" : "LaunchAgent";
function supported() { if (!["win32", "darwin"].includes(process.platform)) throw new Error("Background service installation is supported on macOS and Windows; use todocue serve on this platform."); }
export async function installLaunchAgent(paths: RuntimePaths, spec: Parameters<typeof mac.installLaunchAgent>[1]) { supported(); return process.platform === "win32" ? windows.windowsInstall(paths, windows.windowsSpec(paths, spec)) : mac.installLaunchAgent(paths, spec); }
export async function uninstallLaunchAgent(paths: RuntimePaths) { supported(); return process.platform === "win32" ? windows.windowsUninstall(paths) : mac.uninstallLaunchAgent(paths); }
export async function startLaunchAgent(paths: RuntimePaths) { supported(); return process.platform === "win32" ? windows.windowsStart(paths) : mac.startLaunchAgent(paths); }
export async function stopLaunchAgent(paths: RuntimePaths) { supported(); return process.platform === "win32" ? windows.windowsStop(paths) : mac.stopLaunchAgent(paths); }
export async function restartLaunchAgent(paths: RuntimePaths) { supported(); return process.platform === "win32" ? windows.windowsRestart(paths) : mac.restartLaunchAgent(paths); }
export async function launchAgentStatus(paths: RuntimePaths) { if (process.platform === "win32") return windows.windowsStatus(paths); if (process.platform === "darwin") return mac.launchAgentStatus(paths); return { installed: false, loaded: false, pid: null, detail: "Foreground runtime; background service is not installed" }; }
