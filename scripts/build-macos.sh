#!/usr/bin/env bash
# Builds the TodoCue macOS app and the TodoCueNotifier helper as ad-hoc signed .app bundles.
# Usage: scripts/build-macos.sh [--debug]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/apps/macos"
OUT="$PKG/build"
CONFIG=release
if [[ "${1:-}" == "--debug" ]]; then CONFIG=debug; fi

echo "==> swift build -c $CONFIG"
(cd "$PKG" && swift build -c "$CONFIG" --product TodoCue 2>&1 | tail -2)
(cd "$PKG" && swift build -c "$CONFIG" --product TodoCueNotifier 2>&1 | tail -2)
BIN="$(cd "$PKG" && swift build -c "$CONFIG" --show-bin-path)"

make_bundle() {
  local name="$1" bundle_id="$2" exe="$3" extra_plist="$4"
  local app="$OUT/$name.app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  if [[ ! -x "$BIN/$exe" ]]; then echo "missing build product $BIN/$exe" >&2; exit 1; fi
  cp "$BIN/$exe" "$app/Contents/MacOS/$exe"
  printf 'APPL????' > "$app/Contents/PkgInfo"
  cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleExecutable</key><string>$exe</string>
  <key>CFBundleIdentifier</key><string>$bundle_id</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundleDisplayName</key><string>$name</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>TodoCue</string>
$extra_plist
</dict>
</plist>
PLIST
  if [[ -f "$OUT/AppIcon.icns" ]]; then
    cp "$OUT/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"
    /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string AppIcon" "$app/Contents/Info.plist" >/dev/null
  fi
  codesign --force --deep --sign - "$app" 2>/dev/null
  echo "$app"
}

make_icon() {
  # Cheap programmatic icon: mint rounded square with a check mark, via Swift + CoreGraphics.
  local iconset="$OUT/AppIcon.iconset"
  [[ -f "$OUT/AppIcon.icns" ]] && return 0
  mkdir -p "$iconset"
  cat > "$OUT/icon.swift" <<'SWIFT'
import AppKit
let sizes: [(String, Int)] = [("16x16",16),("16x16@2x",32),("32x32",32),("32x32@2x",64),("128x128",128),("128x128@2x",256),("256x256",256),("256x256@2x",512),("512x512",512),("512x512@2x",1024)]
let dir = CommandLine.arguments[1]
for (name, px) in sizes {
    let img = NSImage(size: NSSize(width: px, height: px))
    img.lockFocus()
    let r = NSRect(x: 0, y: 0, width: px, height: px).insetBy(dx: CGFloat(px)*0.06, dy: CGFloat(px)*0.06)
    let path = NSBezierPath(roundedRect: r, xRadius: CGFloat(px)*0.22, yRadius: CGFloat(px)*0.22)
    NSColor(red: 0.05, green: 0.06, blue: 0.08, alpha: 1).setFill(); path.fill()
    let check = NSBezierPath()
    check.lineWidth = CGFloat(px) * 0.11
    check.lineCapStyle = .round; check.lineJoinStyle = .round
    check.move(to: NSPoint(x: CGFloat(px)*0.28, y: CGFloat(px)*0.50))
    check.line(to: NSPoint(x: CGFloat(px)*0.44, y: CGFloat(px)*0.34))
    check.line(to: NSPoint(x: CGFloat(px)*0.73, y: CGFloat(px)*0.66))
    NSColor(red: 0.40, green: 0.90, blue: 0.75, alpha: 1).setStroke(); check.stroke()
    img.unlockFocus()
    let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
    rep.size = NSSize(width: px, height: px)
    let png = rep.representation(using: .png, properties: [:])!
    try! png.write(to: URL(fileURLWithPath: "\(dir)/icon_\(name).png"))
}
SWIFT
  if swiftc -O -o "$OUT/icon" "$OUT/icon.swift" 2>/dev/null && "$OUT/icon" "$iconset" && iconutil -c icns "$iconset" -o "$OUT/AppIcon.icns" 2>/dev/null; then
    echo "==> icon: $OUT/AppIcon.icns"
  else
    echo "==> icon generation skipped"
  fi
  rm -rf "$iconset" "$OUT/icon" "$OUT/icon.swift"
}

mkdir -p "$OUT"
make_icon

URL_TYPES='  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>com.todocue.app</string>
      <key>CFBundleURLSchemes</key><array><string>todocue</string></array>
    </dict>
  </array>'

echo "==> assembling bundles"
make_bundle "TodoCue" "com.todocue.app" "TodoCue" "$URL_TYPES" >/dev/null
make_bundle "TodoCueNotifier" "com.todocue.notifier" "TodoCueNotifier" "" >/dev/null
APP="$OUT/TodoCue.app"
HELPER="$OUT/TodoCueNotifier.app"

echo
echo "TodoCue app:      $APP"
echo "Notifier helper:  $HELPER"
echo "Helper binary:    $HELPER/Contents/MacOS/TodoCueNotifier"
