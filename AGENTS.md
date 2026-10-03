# Repository Guidelines

## Project Structure & Module Organization

TodoCue combines a local TypeScript runtime with a SwiftUI/AppKit macOS client.

- `packages/engine`: task rules, scheduling, attachments, and SQLite persistence.
- `packages/server`: Fastify API, authentication, and SSE updates.
- `packages/cli`: CLI commands and MCP integration; `packages/shared`: shared types and Zod schemas.
- TypeScript sources live in each package's `src/`; tests live in `test/`.
- `apps/macos/Sources/`: `TodoCue` UI, `TodoCueKit` client library, and `TodoCueNotifier`; native tests live in `apps/macos/Tests/`.
- `scripts/`: builds, releases, and smoke checks; `docs/`: API, design, and QA documentation; `assets/readme/`: screenshots; `skills/todocue/`: distributable Agent Skill.

## Build, Test, and Development Commands

Use Node 24+; native development requires macOS 14+ and Xcode 26 / Swift 6. Run commands from the repository root.

- `npm ci`: install locked workspace dependencies.
- `npm run build`: compile TypeScript packages into `dist/`.
- `TODOCUE_HOME=/tmp/todocue-dev npm run dev:serve`: start the runtime with isolated development data.
- `npm test` / `npm run test:watch`: run Vitest once or continuously.
- `swift test --package-path apps/macos`: run native tests.
- `npm run macos:build` / `npm run macos:dmg`: create app bundles or a standalone DMG in `apps/macos/build/`.
- `npm run check`: run the build, Vitest, release-script tests, smoke checks, and release validation.
- `npm run check:macos`: run those checks plus Swift tests.

## Coding Style & Naming Conventions

Follow surrounding code: TypeScript uses two-space indentation, double quotes, semicolons, strict types, and ESM imports with `.js` suffixes for relative modules. Swift uses four-space indentation. Use PascalCase for types and camelCase for functions and properties. Keep shared contracts in `packages/shared`. No dedicated formatter or linter is configured.

## Testing Guidelines

Use Vitest files named `packages/*/test/**/*.test.ts`, Node's test runner for `scripts/tests/*.test.mjs`, and XCTest files named `*Tests.swift` with `test...` methods. Add behavioral regression tests for fixes; isolate databases and use controlled clocks for scheduling. No numeric coverage threshold is configured. Run relevant tests and the quality gates before submitting.

## Commit & Pull Request Guidelines

History uses prefixes such as `feat:`, `fix:`, `docs:`, `ci:`, and `release:`, often with Chinese summaries. Keep commits focused. PRs should explain behavior changes, link relevant issues, and report validation. Include screenshots for UI changes and update affected API documentation and both READMEs.

## Agent Instructions

Use the `ego-browser` skill for interactive browser automation unless explicitly directed otherwise or Ego Lite is unavailable.
