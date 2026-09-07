#!/usr/bin/env bash
# Only run on a disposable GitHub-hosted macOS runner.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == "true" ]] || { echo 'This script is for GitHub Actions runners.' >&2; exit 1; }
: "${RUNNER_TEMP:?}" "${GITHUB_ENV:?}"
: "${MACOS_CERTIFICATE:?}" "${MACOS_CERTIFICATE_PASSWORD:?}"
: "${APPLE_ID:?}" "${APPLE_APP_SPECIFIC_PASSWORD:?}" "${APPLE_TEAM_ID:?}"
umask 077
certificate_path="$RUNNER_TEMP/todocue-signing.p12"
keychain_path="$RUNNER_TEMP/todocue-signing.keychain-db"
keychain_password="$(uuidgen)"
echo "::add-mask::$keychain_password"
trap 'rm -f "$certificate_path"' EXIT
printf '%s' "$MACOS_CERTIFICATE" | base64 --decode > "$certificate_path"
security create-keychain -p "$keychain_password" "$keychain_path"
security set-keychain-settings -lut 21600 "$keychain_path"
security unlock-keychain -p "$keychain_password" "$keychain_path"
security import "$certificate_path" -k "$keychain_path" -P "$MACOS_CERTIFICATE_PASSWORD" \
  -t cert -f pkcs12 -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain_path" > /dev/null
security list-keychains -d user -s "$keychain_path" "$HOME/Library/Keychains/login.keychain-db"
# Resolve only the imported identity and require the intended Developer ID team.
identity="$(TODOCUE_SIGN_KEYCHAIN="$keychain_path" node --input-type=module -e '
  import { execFileSync } from "node:child_process";
  import { signingIdentity } from "./scripts/macos-signing.mjs";
  const output = execFileSync("security", ["find-identity", "-v", "-p", "codesigning", process.env.TODOCUE_SIGN_KEYCHAIN], { encoding: "utf8" });
  console.log(signingIdentity(output, { required: true, teamId: process.env.APPLE_TEAM_ID }));
')"
xcrun notarytool store-credentials todocue-release --keychain "$keychain_path" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" > /dev/null
{
  echo "TODOCUE_SIGN_IDENTITY=$identity"
  echo "TODOCUE_SIGN_KEYCHAIN=$keychain_path"
  echo 'TODOCUE_NOTARY_PROFILE=todocue-release'
} >> "$GITHUB_ENV"
