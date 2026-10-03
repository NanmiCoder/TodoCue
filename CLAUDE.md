# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm ci                       # Node 24+ required (CI pins 26.7.0)
npm run build                # tsc -b across the 4 workspace packages
npm test                     # vitest (packages/*/test/**/*.test.ts) — runs against src via aliases, no build needed
npm run typecheck
npm run dev:serve            # tsx packages/cli/src/index.ts serve

npx vitest run packages/engine/test/engine.test.ts        # one file
npx vitest run -t "recurring"                             # one test by name

swift test --package-path apps/macos                      # TodoCueKit + TodoCue XCTests
swift test --package-path apps/macos --filter ReschedulingTests

scripts/build-macos.sh [--debug]   # ad-hoc signed TodoCue.app + TodoCueNotifier.app → apps/macos/build/
npm run macos:dmg                  # standalone DMG (downloads + checksum-verifies pinned official Node)

npm run check          # build + test + test:release + test:smoke + release:check — the gate CI runs
npm run check:macos    # check + swift test
```

`npm run test:smoke` (`scripts/smoke.mjs`) spawns a **real** runtime, CLI and MCP process against a temp
`TODOCUE_HOME`; it requires `npm run build` first. `npm run test:release` runs `node --test scripts/tests/*.test.mjs`.

Set `TODOCUE_HOME=/some/dir` (and optionally `TODOCUE_PORT`) to isolate any manual run from the user's
real `~/.todocue` data. Other env: `TODOCUE_TZ`, `TODOCUE_LOG_HTTP=1`, `TODOCUE_NOTIFIER`,
`TODOCUE_PREVIEW_{APPEARANCE,HEIGHT,LANGUAGE}` (DEBUG Swift builds only).

## Architecture

One local runtime; everything else is a thin HTTP client of it.

```
TodoCue.app (SwiftUI/AppKit) ─┐
todocue CLI ──────────────────┼─ 127.0.0.1:47831 + Bearer token ─ Fastify ─ TaskEngine ─ SQLite (WAL)
todocue mcp (stdio) ──────────┘                                       │
TodoCueNotifier.app ◄──────────── Scheduler execFile ─────────────────┘
```

| Package | Role |
|---|---|
| `packages/shared` | The contract: Zod 4 schemas (`schemas.ts`), error codes (`errors.ts`), `RUNTIME_VERSION`, `DEFAULT_PORT`, `API_PREFIX`. All three interfaces reuse these types — **change entities here first**. |
| `packages/engine` | `TaskEngine` (all task/series/reminder rules, ordering, idempotency store), `db.ts` (migrations + `VACUUM INTO` backup), `scheduler.ts` (5s tick), `notifier.ts` (helper bridge, osascript fallback). `Clock` is injected so tests control time. |
| `packages/server` | `app.ts` (routes, token auth, `Idempotency-Key`, SSE `/v1/events` with `Last-Event-ID` replay), `runtime.ts` (single-instance check, writes `connection.json`), `client.ts` (typed client shared by CLI + MCP), `config.ts` (all `~/.todocue` paths and permissions). |
| `packages/cli` | commander CLI: task commands, `serve`, `service *`, `install`, `bootstrap`, `doctor`, `export`, `mcp`. `bootstrap.ts` + `launchagent.ts` install the LaunchAgent and the `todocue` wrapper on first app launch. |
| `apps/macos` | `TodoCueKit` (API client, Codable models, SSE parser, localization), `TodoCue` (menu bar app, side panel, notch quick look), `TodoCueNotifier` (notification helper). SwiftPM only, no Xcode project, no third-party deps. |
| `skills/todocue` | The distributed Agent Skill — its CLI flag/behaviour descriptions must stay true to `packages/cli`. |

**`docs/api.md` is the API contract**, referenced by both the Swift client and the CLI. Update it in the
same change as any route, field, or error-code change; `apps/macos/README.md` documents the notifier
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

### macOS client

Reads `~/.todocue/connection.json` (honours `TODOCUE_HOME`) for base URL + token, watches that directory
so a runtime restart reconnects, subscribes to `/v1/events` **before** loading `/v1/context`, `/today`,
`/next`, `/tasks`. Offline: keep the last data, show the banner, disable writes.

UI strings are authored in Chinese and passed through `L10n.tr("…")`, with English supplied by
`TodoCueKit/Translations.swift`. Adding user-visible copy means adding a matching English entry there;
`LocalizationTests` guards the catalog. User task content is never translated.

## Versioning and release

`package.json`, `package-lock.json`, all four `packages/*/package.json` (including their `@todocue/*`
dependency pins) and `RUNTIME_VERSION` in `packages/shared/src/index.ts` must all match — `npm run
release:check` enforces this, so never bump a version by hand. Use `npm run release -- patch|minor|major|x.y.z
[--dry]`, which requires a non-empty `release-notes/vX.Y.Z.md` to already exist, then commits
`release: vX.Y.Z` and tags. Pushing a `vX.Y.Z` tag runs `.github/workflows/release-macos.yml`
(validate → build → sign → notarize → publish both architectures).

## Conventions

- Commit messages: Chinese, conventional-style prefix (`feat:`, `fix:`, `docs:`, `ci:`, `release:`).
- Docs under `docs/` and release notes are Chinese; `README.md` is English with `README.zh-CN.md` alongside —
  keep the two READMEs in sync when either changes.
- `.ui-review/` is a gitignored scratch area for local UI verification artifacts (screenshots, isolated
  preview apps, build logs); `docs/ui-review.md` and `docs/qa/` record the results.
- Notch and panel behaviour can only be verified on real hardware — see `docs/ui-review.md` for the
  accepted verification procedure and its stated limits.
