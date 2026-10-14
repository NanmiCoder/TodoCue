import fs from "node:fs";
import path from "node:path";

export const runtimePackages = ["shared", "client", "engine", "server", "cli"];
/** Stage just the locked runtime, without pulling React/Tauri into the background service. */
export function stageRuntime(root, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  pkg.workspaces = ["packages/*"];
  lock.packages[""].workspaces = pkg.workspaces;
  delete lock.packages["apps/desktop"];
  delete lock.packages["node_modules/@todocue/desktop"];
  fs.writeFileSync(path.join(destination, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  fs.writeFileSync(path.join(destination, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
  for (const name of runtimePackages) {
    for (const file of ["package.json", "dist"]) {
      const target = path.join(destination, "packages", name, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(path.join(root, "packages", name, file), target, { recursive: true });
    }
  }
}
