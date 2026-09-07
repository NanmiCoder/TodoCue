#!/usr/bin/env bash
set -euo pipefail
: "${GITHUB_REPOSITORY:?}" "${RELEASE_VERSION:?}"
tag="v$RELEASE_VERSION"
notes="release-notes/$tag.md"
[[ "$tag" == "${GITHUB_REF_NAME:?}" ]] || { echo 'Tag mismatch' >&2; exit 1; }
[[ -s "$notes" ]] || { echo "Missing $notes" >&2; exit 1; }
error_file="$(mktemp)"
trap 'rm -f "$error_file"' EXIT

# A failed upload can be retried against its draft, but never replace a public release.
if state="$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" --jq '.draft' 2>"$error_file")"; then
  if [[ "$state" != true ]]; then
    echo "Release $tag is already public; refusing to replace published assets." >&2
    exit 1
  fi
else
  if ! grep -q 'HTTP 404' "$error_file"; then cat "$error_file" >&2; exit 1; fi
  gh release create "$tag" --repo "$GITHUB_REPOSITORY" --verify-tag --draft \
    --title "TodoCue $tag" --notes-file "$notes"
fi
gh release upload "$tag" --repo "$GITHUB_REPOSITORY" --clobber \
  "release-assets/TodoCue-$RELEASE_VERSION-macOS-arm64.dmg" \
  "release-assets/TodoCue-$RELEASE_VERSION-macOS-x64.dmg" \
  release-assets/SHA256SUMS
gh release edit "$tag" --repo "$GITHUB_REPOSITORY" --draft=false --latest \
  --title "TodoCue $tag" --notes-file "$notes"
