import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
for (const name of fs.readdirSync(path.join(root, "packages"))) {
  for (const output of ["dist", "tsconfig.tsbuildinfo"]) fs.rmSync(path.join(root, "packages", name, output), { recursive: true, force: true });
}
fs.rmSync(path.join(root, "apps/desktop/dist"), { recursive: true, force: true });
