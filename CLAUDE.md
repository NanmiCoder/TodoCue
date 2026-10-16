# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Which client is the product

Since v0.6.0 the shipped desktop client is the shared **React + Tauri 2** app in `apps/desktop` (macOS
ARM64/Intel and Windows x64/ARM64). New UI work and fixes go there. `apps/macos` (SwiftUI/AppKit) is **not
deleted**: it still owns Apple Calendar/Reminders sync (EventKit), real hardware-notch geometry and preference
import, none of which are ported; v0.5.3 is the rollback for users who need them; and its source is the visual
and behavioural reference the desktop UI is compared against. Do not add features to it unless they depend on one
of those unported capabilities. Only one client may use a data directory at a time (the desktop app asks the
user to quit a running SwiftUI app).

## Commands

```bash
npm ci                       # Node 24+ required (CI pins 26.7.0)
npm run build                # tsc -b across the 5 workspace packages (shared, engine, server, client, cli)
npm test                     # vitest: packages/*/test + apps/desktop/test — runs against src via aliases, no build needed
npm run typecheck
npm run dev:serve            # tsx packages/cli/src/index.ts serve

npx vitest run packages/engine/test/engine.test.ts        # one file
npx vitest run -t "recurring"                             # one test by name

# desktop client (apps/desktop)
TODOCUE_HOME=/tmp/todocue-desktop-dev npm run desktop:dev   # isolated runtime on :47832 + Vite on :5173
                                                            # open http://127.0.0.1:5173/ (panel) and /?surface=notch
npm run desktop:native       # Tauri dev window; point it at the same TODOCUE_HOME as a running runtime
npm run desktop:check        # desktop:build (tsc + vite build) + cargo test for src-tauri
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml <name>   # one Rust test
npm run desktop:macos [-- --release]    # shared Mac app/DMG (--release = Developer ID sign + notarize)
npm run windows:build -- --release      # Windows NSIS installer for the host architecture (run on Windows)

# legacy SwiftUI client
swift test --package-path apps/macos                      # TodoCueKit + TodoCue XCTests
swift test --package-path apps/macos --filter ReschedulingTests
scripts/build-macos.sh [--debug]   # ad-hoc signed SwiftUI TodoCue.app + TodoCueNotifier.app → apps/macos/build/

npm run check          # build + test + test:release + test:smoke + release:check — the gate CI runs
npm run check:macos    # check + swift test
```

`npm run check` does **not** run `vite build` or `cargo test`; run `npm run desktop:check` as well for desktop
changes. `npm run test:smoke` (`scripts/smoke.mjs`) spawns a **real** runtime, CLI and MCP process against a temp
`TODOCUE_HOME`; it requires `npm run build` first. `npm run test:release` runs `node --test scripts/tests/*.test.mjs`.

Set `TODOCUE_HOME=/some/dir` (and optionally `TODOCUE_PORT`) to isolate any manual run from the user's
real `~/.todocue` data. Other env: `TODOCUE_TZ`, `TODOCUE_LOG_HTTP=1`, `TODOCUE_NOTIFIER`,
`TODOCUE_PREVIEW_{APPEARANCE,HEIGHT,LANGUAGE}` (DEBUG Swift builds only).

**Never `pkill -f` a pattern like `index.js serve`.** The user's real runtime listens on 47831 under a
LaunchAgent (`com.todocue.runtime`) and matches it. Record the PID of every process you start and kill only
those; use ports other than 47831/47832 when 47832 may be busy.

## Architecture

One local runtime; everything else is a thin HTTP client of it.

```
TodoCue.app (Tauri: panel + notch WebViews) ─┐
TodoCue.app (legacy SwiftUI) ────────────────┤
todocue CLI ─────────────────────────────────┼─ 127.0.0.1:47831 + Bearer token ─ Fastify ─ TaskEngine ─ SQLite (WAL)
todocue mcp (stdio) ─────────────────────────┘                                       │
notifier helper ◄───────────────────────── Scheduler execFile ───────────────────────┘
```

| Package | Role |
|---|---|
| `packages/shared` | The contract: Zod 4 schemas (`schemas.ts`), error codes (`errors.ts`), `RUNTIME_VERSION`, `DEFAULT_PORT`, `API_PREFIX`. Every interface reuses these types — **change entities here first**. |
| `packages/engine` | `TaskEngine` (all task/series/reminder rules, ordering, idempotency store), `db.ts` (migrations + `VACUUM INTO` backup), `scheduler.ts` (5s tick), `notifier.ts` (helper bridge, osascript fallback). `Clock` is injected so tests control time. |
| `packages/server` | `app.ts` (routes, token auth, `Idempotency-Key`, SSE `/v1/events` with `Last-Event-ID` replay), `runtime.ts` (single-instance check, writes `connection.json`), `client.ts` (typed client for CLI + MCP, `fromHome()`), `config.ts` (all `~/.todocue` paths and permissions). |
| `packages/client` | Portable typed `TodoCueClient` that takes an injected `transport`; used by the desktop frontend (no Node/fs dependency). |
| `packages/cli` | commander CLI: task commands, `serve`, `service *`, `install`, `bootstrap`, `doctor`, `export`, `mcp`. `bootstrap.ts` + `launchagent.ts` (macOS) and `windows-service.ts` + `windows-integration.ts` (Windows scheduled task, CLI/PATH, uninstall) install the background runtime and `todocue` wrapper on first app launch. |
| `apps/desktop` | The shipped client: `src/` React UI, `src-tauri/` Rust host. See below. |
| `apps/macos` | Legacy SwiftUI client (see top): `TodoCueKit`, `TodoCue`, `TodoCueNotifier`. SwiftPM only, no third-party deps. |
| `skills/todocue` | The distributed Agent Skill — its CLI flag/behaviour descriptions must stay true to `packages/cli`. |

**`docs/api.md` is the API contract**, referenced by the desktop client, the Swift client and the CLI. Update it in
the same change as any route, field, or error-code change; `apps/macos/README.md` documents the notifier
helper's exact JSON contract, and Swift decoding tests are written against these fixtures.

### Invariants worth knowing before editing the engine

- **Time**: instants stored as UTC ISO, tasks carry an IANA timezone; `scheduledDate` xor `scheduledAt`,
  `dueDate` xor `dueAt`; offset-free local ISO is interpreted in the request timezone (luxon).
- **Ordering**: `today` reasons are `overdue|due_today|scheduled_today|carried_over`; `next` groups are
  `overdue → due_today → scheduled_reached → unscheduled`. Clients render this order; they never invent one.
- **Series**: daily/weekly, instances pre-generated 30 days ahead and tracked by `generatedThrough`;
  a `(series_id, occurrence_date)` unique index prevents duplicates. Editing a rule = stop + create new.
- **Reminders**: at most one per task, kept in sync with `task.reminderAt` inside the same transaction;
  completing/cancelling/skipping invalidates a pending reminder; undoing completion never re-fires a past one.
- **Concurrency**: mutating calls take `expectedVersion` → `VERSION_CONFLICT`; writes may carry
  `Idempotency-Key` (stored 24h; same key + different body → `IDEMPOTENCY_MISMATCH`).
- **Security posture**: listen on 127.0.0.1 only; `~/.todocue` is 0700, `token`/`connection.json` 0600.
- Schema changes are append-only migrations in `db.ts`; the existing `migrations` array is history, not
  something to rewrite.

### Desktop client (`apps/desktop`)

- **Two WebView windows, one bundle.** `main.tsx` renders `<Panel/>` or `<Notch/>` from `?surface=notch`. The
  panel is the side tray; the notch is a transparent always-on-top window the Rust host resizes to its content
  (`presentNotch` → `notch_present`), so anything the notch draws outside its measured content (e.g. a context
  menu) is clipped unless the window height accounts for it.
- **The WebView never holds the token.** `bridge.ts` sends every request through `invoke("runtime_request")`; the
  Rust host (`runtime.rs`) reads `connection.json`, attaches the Bearer token, proxies REST and relays SSE
  (`runtime_subscribe`) as Tauri events. In a plain browser (`desktop:dev`) the same calls go to a Vite proxy
  at `/__runtime/v1`, which is what makes the UI testable without Tauri. `native` (from `bridge.ts`) tells
  the two apart.
- **`bridge.ts` ↔ `src-tauri/src/lib.rs` is a hand-kept contract**: command names, argument names (Rust
  `snake_case` args arrive as camelCase in JS) and event names (`panel:revealed`, `notch:collapse`,
  `notch:pointer`, `route:reveal`, …). Change both sides together; a missing command is tolerated by some
  front-end fallbacks, which can hide a rename.
- **Rust host** (`src-tauri/src`): `lib.rs` (commands, tray, windows, pointer polling), `platform.rs` (macOS
  glass/Spaces/click monitors, Windows virtual-desktop/activation), `notch_geometry.rs` / `panel_geometry.rs` /
  `panel_fade.rs` (pure logic kept testable), `export.rs`, `host_tray.rs`, `macos_home.rs` / `windows_home.rs` (data-directory
  selection and per-directory routing), and `bin/` (`cli` and `notifier` helpers; `runtime-host` is the Windows
  background-process supervisor). Keep logic that can be tested without a window in the pure
  modules; every platform-specific call needs a `#[cfg(target_os)]` branch and Linux must still compile.
- **Platform differences go through `src/platform.ts`** (`platform`, `isPrimaryModifier`, `isSubmitChord`,
  `formatShortcut`). macOS shortcuts accept **⌘ only** (Ctrl+N/F/Z mean other things in text fields); Windows
  accepts Ctrl only. Do not sniff the user agent elsewhere.
- **State in key handlers must not be closure-captured.** `Panel.tsx` registers its keyboard handler once and
  reads current state through refs (`shortcuts.ts`); a handler capturing `saving`/`toast` once made ⌘Z silently
  fail. Menu commands likewise re-resolve the task (`taskLookup.ts`) so a menu left open still writes the current
  `version`.
- **Feedback and undo go through one toast slot** (`toast.ts` / `useToasts.ts`: errors auto-dismiss, undo covers
  complete / reorder / reschedule). Esc closes layers in a fixed order (context menu → header menu → delete/move
  confirmation → back → clear search → hide panel); add new layers into that chain.
- Motion values come from `tokens.ts` and `motionKit.tsx` (SwiftUI `spring(response, dampingFraction)` converted
  to stiffness/damping); every animation must also honour `useReducedMotion`. The design language is "Dial":
  `docs/design/dial.md`.
- UI copy is Chinese/English inline pairs (`language === "en" ? … : …`) plus shared keys in `i18n.ts`; user task
  content is never translated.

### Legacy SwiftUI client

Reads `~/.todocue/connection.json` (honours `TODOCUE_HOME`), subscribes to `/v1/events` **before** loading
`/v1/context`, `/today`, `/next`, `/tasks`. UI strings are authored in Chinese and passed through `L10n.tr("…")`,
with English in `TodoCueKit/Translations.swift`; `LocalizationTests` guards the catalog.

## Versioning and release

`package.json`, `package-lock.json`, every `packages/*/package.json` (including their `@todocue/*` pins),
`apps/desktop/package.json`, `apps/desktop/src-tauri/{tauri.conf.json,Cargo.toml,Cargo.lock}` and
`RUNTIME_VERSION` in `packages/shared/src/index.ts` must all match — `npm run release:check` enforces this, so
never bump a version by hand. Use `npm run release -- patch|minor|major|x.y.z [--dry]`, which requires a non-empty
`release-notes/vX.Y.Z.md` to already exist, then commits `release: vX.Y.Z` and tags. Pushing a `vX.Y.Z` tag runs
`.github/workflows/release-macos.yml` (named "Release desktop (Mac and Windows)"): it builds and verifies four
installers (Mac ARM64/Intel with Developer ID signing + notarization, Windows x64/ARM64 NSIS, unsigned) and only
publishes the Release when all four and `SHA256SUMS` exist. `quality.yml` runs `npm run check` plus Swift jobs on
PRs; `desktop-preview.yml` is manual/PR build validation; `republish-macos.yml` re-publishes a verified release.

## Conventions

- Commit messages: Chinese, conventional-style prefix (`feat:`, `fix:`, `docs:`, `ci:`, `release:`).
- Docs under `docs/` and release notes are Chinese; `README.md` is English with `README.zh-CN.md` alongside —
  keep the two READMEs in sync when either changes. PRs for UI changes should include screenshots.
- Use the `ego-browser` skill for interactive browser automation unless told otherwise.
- `.ui-review/` is a gitignored scratch area for local UI verification artifacts (screenshots, isolated
  preview apps, build logs); `docs/ui-review.md` and `docs/qa/` record the results.
- Notch and panel behaviour (hover when the app is inactive, click-through of the transparent window, focus
  stealing, multi-monitor/DPI, full-screen suppression, Spaces) can only be verified on real hardware — see
  `docs/ui-review.md` and `docs/desktop-handoff.md` for the procedure and stated limits. There is no Windows
  device in the usual dev environment: Windows code is type-checked (`cargo check --target
  x86_64-pc-windows-msvc` needs the Windows SDK headers, so the whole crate cannot be built on a Mac), not run.
  Report such code as implemented-but-unverified, never as passing.
- `docs/desktop-handoff.md` is the living list of unfinished desktop work and hardware acceptance;
  `docs/desktop-migration.md` holds evidence tables.
