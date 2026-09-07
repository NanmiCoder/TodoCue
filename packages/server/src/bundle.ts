import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The packaged runtime retains the workspace layout beneath Contents/Resources/runtime. */
export function runtimeRoot(moduleUrl = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "..", "..");
}

export function appBundle(root = runtimeRoot()): string | null {
  if (path.basename(root) !== "runtime" || path.basename(path.dirname(root)) !== "Resources" ||
      path.basename(path.dirname(path.dirname(root))) !== "Contents") return null;
  const app = path.resolve(root, "..", "..", "..");
  return app.endsWith(".app") && fs.existsSync(path.join(app, "Contents", "Info.plist")) ? app : null;
}

export function packagedHelper(app = appBundle()): string | null {
  if (!app) return null;
  const executable = path.join(app, "Contents", "Helpers", "TodoCueNotifier.app", "Contents", "MacOS", "TodoCueNotifier");
  return fs.existsSync(executable) ? executable : null;
}
