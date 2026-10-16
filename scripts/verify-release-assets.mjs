import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateVersion } from "./release.mjs";

export function verifyReleaseAssets(directory, version) {
  validateVersion(version);
  const names = ["macOS-arm64.dmg", "macOS-x64.dmg", "Windows-arm64-setup.exe", "Windows-x64-setup.exe"]
    .map(suffix => `TodoCue-${version}-${suffix}`);
  const lines = names.map(name => {
    const bytes = fs.readFileSync(path.join(directory, name));
    if (!bytes.length) throw new Error(`Empty installer: ${name}`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const expected = fs.readFileSync(path.join(directory, `${name}.sha256`), "utf8").trim();
    if (expected !== `${digest}  ${name}`) throw new Error(`Installer checksum mismatch: ${name}`);
    return `${digest}  ${name}`;
  });
  fs.writeFileSync(path.join(directory, "SHA256SUMS"), lines.join("\n") + "\n");
  return names;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(verifyReleaseAssets(process.argv[2] ?? "release-assets", process.env.RELEASE_VERSION).join("\n"));
}
