import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { WindowsRuntimeSpec } from "./windows-service.js";

export interface WindowsHome {
  id: string;
  home: string;
  runtimeRoot: string;
  cliPathManaged?: boolean;
  resumeAfterUpgrade?: boolean;
}
export const sameWindowsPath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
export const windowsHomeId = (home: string) => createHash("sha256").update(path.resolve(home).toLowerCase()).digest("hex").slice(0, 12);
export const windowsHomesDirectory = () => path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "TodoCue", "homes");
export const specRuntimeRoot = (spec: WindowsRuntimeSpec) => path.resolve(spec.cliEntry, "../../../..");
export function windowsHomes(root: string): WindowsHome[] {
  const dir = windowsHomesDirectory();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap(name => {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as WindowsHome;
      return typeof value.home === "string" && typeof value.runtimeRoot === "string" &&
        value.id === windowsHomeId(value.home) && name === `${value.id}.json` && sameWindowsPath(value.runtimeRoot, root) ? [value] : [];
    } catch { return []; }
  });
}
export function saveWindowsHome(value: WindowsHome): void {
  const dir = windowsHomesDirectory();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${value.id}.json`), temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, target);
}
export function registerWindowsHome(spec: WindowsRuntimeSpec, cliPathManaged = false): WindowsHome {
  const root = specRuntimeRoot(spec);
  const previous = windowsHomes(root).find(value => sameWindowsPath(value.home, spec.home));
  const value = { ...previous, id: windowsHomeId(spec.home), home: path.resolve(spec.home), runtimeRoot: root,
    cliPathManaged: cliPathManaged || previous?.cliPathManaged || false };
  saveWindowsHome(value);
  return value;
}
export function forgetWindowsHome(value: WindowsHome): void {
  fs.rmSync(path.join(windowsHomesDirectory(), `${value.id}.json`), { force: true });
}
