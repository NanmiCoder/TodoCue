# TodoCue macOS client

SwiftUI + AppKit menu-bar app with a notch quick-look and a floating side panel, plus the
`TodoCueNotifier` helper that delivers system notifications for the Node runtime.
Minimum macOS 14, SwiftPM only (no Xcode project), no third-party dependencies.

## Layout

| Path | What |
|---|---|
| `Sources/TodoCueKit` | API client, Codable models (docs/api.md), SSE client, date helpers |
| `Sources/TodoCue` | The app: `AppDelegate`, `AppModel`, `StatusItemController`, `SidePanelController`, `NotchController`, SwiftUI views |
| `Sources/TodoCueNotifier` | Notification helper (`status` / `request` / `deliver` / click handling) |
| `Tests/TodoCueKitTests` | Decoding + SSE parser tests against docs/api.md fixtures |
| `build/` | Output of `scripts/build-macos.sh` (`TodoCue.app`, `TodoCueNotifier.app`) |

## Build & run

```bash
cd apps/macos
swift build            # debug build of everything
swift test             # TodoCueKit tests
../../scripts/build-macos.sh          # release bundles → apps/macos/build/
../../scripts/build-macos.sh --debug  # debug bundles
open apps/macos/build/TodoCue.app                     # shows the side panel
open apps/macos/build/TodoCue.app --args --background # menu bar only (what a login-item launch does)
```

Both bundles are ad-hoc signed (`codesign --sign -`), `LSUIElement=true`, and carry a programmatic
icon. The app registers the `todocue` URL scheme (`CFBundleURLTypes`).

The app reads `~/.todocue/connection.json` (or `$TODOCUE_HOME/connection.json`) for the base URL and
bearer token, watches that directory so a runtime restart reconnects automatically, subscribes to
`/v1/events` first, then loads `/v1/context`, `/v1/today`, `/v1/next`, `/v1/tasks`.
If the runtime is not running the panel shows an offline banner, keeps the last data and disables writes.

## Notifier helper contract

The runtime invokes `TodoCueNotifier.app/Contents/MacOS/TodoCueNotifier <command>`. It must run from
inside the bundle (UNUserNotificationCenter needs a bundle identifier; otherwise it prints an error and exits 2).
Every command prints exactly one JSON line on stdout.

| Command | Output |
|---|---|
| `status` | `{"ok":true,"authorization":"authorized\|provisional\|denied\|notDetermined","alertStyle":"none\|banner\|alert"}` |
| `request` | requests alert+sound+badge, then prints the same shape as `status` (plus `error` if the request failed) |
| `deliver --id <id> --title <t> [--body b] [--subtitle s] [--task-id tid] [--thread th] [--sound]` | `{"ok":true,"channel":"helper","authorization":"…"}` (exit 0) or `{"ok":false,"error":"…"}` (exit 1; `notifications denied` when authorization is denied) |
| *(no args)* | launched by macOS for a notification click/action; handles it and exits (5 s idle timeout) |

Delivered notifications use the stable identifier passed with `--id` (re-delivery replaces the old one),
category `TODOCUE_REMINDER` with actions `COMPLETE` (完成) and `SNOOZE` (10 分钟后提醒), and
`userInfo.taskId`. On click the helper opens `todocue://task/<taskId>`; `COMPLETE`/`SNOOZE` call
`POST /v1/tasks/<id>/complete` / `POST /v1/tasks/<id>/snooze {"minutes":10}` with the token from connection.json.

Expected install locations searched by `todocue install` / `doctor`:
`~/.todocue/bin/TodoCueNotifier.app` (copied by install) or `apps/macos/build/TodoCueNotifier.app` (dev checkout).
`TODOCUE_NOTIFIER` may point at the binary explicitly.

## URL scheme

`todocue://task/<taskId>` reveals the task in the side panel (opens the panel if needed);
`todocue://open` just opens the panel.

## Behaviour notes

- **Notch quick-look** exists only on screens where `NSScreen.safeAreaInsets.top > 0`. The window is a
  non-activating panel above the status bar; collapsed it is just the notch width + 10 pt each side.
  Hover ≥ 200 ms expands (260 ms), leaving hot zone + panel for 350 ms collapses (180 ms).
  Reduce Motion switches to short fades. Hover uses a global mouse-moved monitor plus a 50 ms poll while
  the pointer is near the top edge (no Accessibility permission needed).
- **Fullscreen heuristic**: auto-expand is suppressed when the frontmost app owns an on-screen window
  whose size equals the notch screen's full frame (`CGWindowListCopyWindowInfo`). Toggle in settings.
- **Side panel**: 380×680 pt, 12 pt from the top-right of the visible frame of the screen under the mouse,
  clamped on small screens; draggable; The panel stays visible when you work in another app. Showing it does not activate TodoCue;
  only an explicit editing action requests keyboard input. Close with the × button or Esc while the
  panel has keyboard focus. Pin protects the root panel from accidental Esc (× still closes it).
  Back / Esc from a form preserves the draft; ⌘N or “继续草稿” restores it. Repositions on screen/space changes.
- Keyboard: ⌘N new task, ⌘F focus quick add, ⌘R refresh, ⌘, settings, ⌘[ back, ⌘W/Esc close layer, ⌘Z undo in toast, ⌘Return save form (Return remains available for multiline text).
- Global hotkey: Carbon `RegisterEventHotKey`, unbound by default, recorded in settings, stored in UserDefaults.
- Login item: `SMAppService.mainApp`; a login-item launch (`keyAELaunchedAsLogInItem`) stays in the menu bar.

## Known limitations

- The app is not sandboxed or notarized; ad-hoc signature only. The login item requires the `.app`
  to stay at a stable path (copy it to `/Applications` or `~/Applications`).
- Notification authorization is per bundle: the helper's bundle identifier `com.todocue.notifier` is what
  appears in System Settings › Notifications.
- `SMAppService.mainApp` status is only meaningful once the app has been launched from its final location.
- Notch geometry comes from `auxiliaryTopLeftArea` / `auxiliaryTopRightArea`; if those are unavailable a
  180 pt centered notch is assumed.
- The upcoming tab is derived client-side from `/v1/tasks?from=<tomorrow>&includeUnscheduled=false`.

## UI review (2026-09-07)

The Today tab highlights the next task once and excludes it from the remaining groups without changing
the total count. Tabs stay above the scroll region; completed tasks scroll with the list. Quick add
explicitly schedules a task for today, preserves unsent text across navigation, and clears it only after
success. Form content, task attributes and schedule are separate sections. Calendar popovers and the
form validation message remain usable in a short panel. Undo feedback stays visible for 10 seconds and
does not cover the quick-add field.

Debug bundles accept `TODOCUE_PREVIEW_APPEARANCE=light|dark` and `TODOCUE_PREVIEW_HEIGHT=460` for per-process
visual checks. These options never change system preferences and are excluded from release builds.

See `../../docs/ui-review.md` for the observed issues, actual Computer use checks and limitations.
