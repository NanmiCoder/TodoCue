#!/usr/bin/env bash
# Builds the TodoCue macOS app and the TodoCueNotifier helper as ad-hoc signed .app bundles.
# Usage: scripts/build-macos.sh [--debug]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/apps/macos"
OUT="$PKG/build"
VERSION="$(node -p "require(process.argv[1]).version" "$ROOT/package.json")"
# Bundle metadata and DMG/runtime versions share package.json as their source.
if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Invalid app version: $VERSION" >&2
  exit 1
fi
CONFIG=release
if [[ "${1:-}" == "--debug" ]]; then CONFIG=debug; fi

echo "==> swift build -c $CONFIG"
(cd "$PKG" && swift build -c "$CONFIG" --product TodoCue 2>&1 | tail -2)
(cd "$PKG" && swift build -c "$CONFIG" --product TodoCueNotifier 2>&1 | tail -2)
BIN="$(cd "$PKG" && swift build -c "$CONFIG" --show-bin-path)"

make_bundle() {
  local name="$1" bundle_id="$2" exe="$3" extra_plist="$4" entitlements="${5:-}" resources="${6:-}"
  local app="$OUT/$name.app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  if [[ ! -x "$BIN/$exe" ]]; then echo "missing build product $BIN/$exe" >&2; exit 1; fi
  cp "$BIN/$exe" "$app/Contents/MacOS/$exe"
  # Bundled faces (Dial's wide numerals); registered at launch from Contents/Resources/Fonts.
  if [[ -n "$resources" ]]; then cp -R "$resources/." "$app/Contents/Resources/"; fi
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
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
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
  codesign --force --deep --sign - ${entitlements:+--entitlements "$entitlements"} "$app" 2>/dev/null
  echo "$app"
}

make_icon() {
  # Native vector mark in the Dial palette, shared with the open-ring cue in the panel and menu bar.
  local iconset="$OUT/AppIcon.iconset"
  [[ -f "$OUT/AppIcon.icns" && "$OUT/AppIcon.icns" -nt "$0" ]] && return 0
  mkdir -p "$iconset"
  cat > "$OUT/icon.swift" <<'SWIFT'
import CoreGraphics
import Foundation
import ImageIO

// Dial icon: a graphite tile on Apple's 1024 grid (824pt body), the signal-orange open ring with
// its cue dot, and a dotted gauge bezel. Proportions are fractions of the tile's width.
let sizes: [(String, Int)] = [("16x16",16),("16x16@2x",32),("32x32",32),("32x32@2x",64),("128x128",128),("128x128@2x",256),("256x256",256),("256x256@2x",512),("512x512",512),("512x512@2x",1024)]
let dir = CommandLine.arguments[1]
let space = CGColorSpace(name: CGColorSpace.sRGB)!
func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor { CGColor(colorSpace: space, components: [r / 255, g / 255, b / 255, a])! }
let orange = rgb(242, 106, 46) // #F26A2E, Dial.orange

for (name, px) in sizes {
    let s = CGFloat(px)
    let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setShouldAntialias(true)
    let tile = CGRect(x: s * 100 / 1024, y: s * 100 / 1024, width: s * 824 / 1024, height: s * 824 / 1024)
    let t = tile.width
    let shape = CGPath(roundedRect: tile, cornerWidth: t * 0.225, cornerHeight: t * 0.225, transform: nil)

    // Tile: soft drop shadow, then graphite lit from above.
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.012), blur: s * 0.03, color: rgb(0, 0, 0, 0.35))
    ctx.addPath(shape); ctx.setFillColor(rgb(24, 25, 27)); ctx.fillPath()
    ctx.restoreGState()
    ctx.saveGState()
    ctx.addPath(shape); ctx.clip()
    let body = CGGradient(colorsSpace: space, colors: [rgb(52, 54, 58), rgb(24, 25, 27)] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(body, start: CGPoint(x: 0, y: tile.maxY), end: CGPoint(x: 0, y: tile.minY), options: [])
    // A thin rim that catches the light along the top edge and fades out by mid-height.
    ctx.addPath(shape); ctx.setLineWidth(max(1, t * 0.008)); ctx.replacePathWithStrokedPath(); ctx.clip()
    let rim = CGGradient(colorsSpace: space, colors: [rgb(255, 255, 255, 0.28), rgb(255, 255, 255, 0)] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(rim, start: CGPoint(x: 0, y: tile.maxY), end: CGPoint(x: 0, y: tile.midY), options: [])
    ctx.restoreGState()

    let c = CGPoint(x: tile.midX, y: tile.midY)
    // The bezel turns to noise below 128px. Small sizes also open the gap wider and thicken the
    // ring, or the cue dot fuses with the ring's ends into a closed "O".
    if px >= 128 {
        ctx.setFillColor(rgb(142, 143, 150))
        let r = t * 0.0094
        for i in 0..<28 {
            let a = CGFloat(i) * 2 * .pi / 28
            let p = CGPoint(x: c.x + t * 0.347 * cos(a), y: c.y + t * 0.347 * sin(a))
            ctx.fillEllipse(in: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2))
        }
    }
    let small = px < 64
    let radius = t * (small ? 0.25 : 0.256), gap: CGFloat = small ? 46 : 26
    let ring = CGMutablePath()
    ring.addArc(center: c, radius: radius, startAngle: gap * .pi / 180, endAngle: (360 - gap) * .pi / 180, clockwise: false)
    ctx.addPath(ring)
    ctx.setStrokeColor(orange); ctx.setLineWidth(t * (small ? 0.09 : 0.054)); ctx.setLineCap(.round); ctx.strokePath()
    let dot = t * (small ? 0.05 : 0.035)
    ctx.setFillColor(orange)
    ctx.fillEllipse(in: CGRect(x: c.x + t * (small ? 0.265 : 0.264) - dot, y: c.y - dot, width: dot * 2, height: dot * 2))

    let url = URL(fileURLWithPath: "\(dir)/icon_\(name).png") as CFURL
    let dest = CGImageDestinationCreateWithURL(url, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    guard CGImageDestinationFinalize(dest) else { exit(1) }
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
  </array>
  <key>NSCalendarsFullAccessUsageDescription</key><string>TodoCue 会把有日期的待办同步到「TodoCue」日历，并读取你在那里的修改。</string>
  <key>NSCalendarsUsageDescription</key><string>TodoCue 会把有日期的待办同步到「TodoCue」日历，并读取你在那里的修改。</string>
  <key>NSRemindersFullAccessUsageDescription</key><string>TodoCue 会把待办同步到「TodoCue」提醒事项列表，并读取你在那里的修改。</string>
  <key>NSRemindersUsageDescription</key><string>TodoCue 会把待办同步到「TodoCue」提醒事项列表，并读取你在那里的修改。</string>'

echo "==> assembling bundles"
make_bundle "TodoCue" "com.todocue.app" "TodoCue" "$URL_TYPES" "$ROOT/scripts/app.entitlements.plist" "$PKG/Resources" >/dev/null
make_bundle "TodoCueNotifier" "com.todocue.notifier" "TodoCueNotifier" "" >/dev/null
APP="$OUT/TodoCue.app"
HELPER="$OUT/TodoCueNotifier.app"

echo
echo "TodoCue app:      $APP"
echo "Notifier helper:  $HELPER"
echo "Helper binary:    $HELPER/Contents/MacOS/TodoCueNotifier"
