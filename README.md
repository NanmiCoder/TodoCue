**English** · [简体中文](README.zh-CN.md)

> **v0.6.0 desktop release:** macOS and Windows now use the shared React/Tauri client. Installers bundle Node, SQLite and notifications; no separate runtime is required. Choose macOS Apple Silicon/Intel or Windows x64/ARM64 from [Releases](https://github.com/NanmiCoder/TodoCue/releases/latest). Mac installers are Developer ID signed and notarized; Windows installers are unsigned. [Upgrade details, rollback and known limits](release-notes/v0.6.0.md). Apple Calendar/Reminders sync and hardware-notch adaptation remain available in the legacy v0.5.3 SwiftUI client; they are not yet supported by the shared client. The older screenshots and descriptions below document that legacy experience where indicated.

<p align="center">
  <img src="assets/readme/hero.webp" width="100%" alt="TodoCue — A little cue. A clearer day. A large signal-orange open ring behind a Dial panel on a glass tray, with a reminder dropping from the notch.">
</p>

<p align="center">
  <strong>Turn your Agent conversations into things that get done.</strong><br>
  Create and manage tasks and reminders with natural language, through Skills.<br>
  TodoCue keeps them visible on your desktop and reminds you when it's time.
</p>

<p align="center">
  <a href="https://github.com/NanmiCoder/TodoCue/releases/latest"><strong>Download for macOS & Windows</strong></a> ·
  <a href="#install-the-skill">Install the Skill</a> ·
  <a href="release-notes/">Release notes</a> ·
  <a href="LICENSE">MIT</a>
</p>

## Plan in the conversation. See it on your desktop.

While you code, discuss ideas, or work across projects with an Agent, little follow-ups come up: check a release tomorrow, send a draft, revisit a decision. Ask your Agent to save them in TodoCue and keep the conversation going. The tasks appear in the desktop panel; set a reminder and TodoCue will notify you when it's time.

**Your Agent is the main way to use TodoCue.** The same Skill lets Claude Code, Codex, Cursor, WorkBuddy, and other Agents that support Skills and local commands create, find, update, and complete tasks. Across projects and Agents, they work with the same task list on your computer.

| Say something like… | What happens |
| --- | --- |
| “Use TodoCue to remind me tomorrow at 9 AM to check this project's release.” | A task is saved with a reminder at the specified time. |
| “Add the three action items we just agreed on to TodoCue under Website redesign.” | Each action item becomes a task in that project. |
| “What's left in TodoCue today?” | Your Agent checks today's tasks and the next suggestion. |
| “Move the release check to 3 PM the day after tomorrow, and move its reminder too.” | Both the plan and reminder are updated. |
| “Mark the release check in TodoCue as done.” | Your Agent finds the task and completes it. |

Your Agent interprets the language. TodoCue stores the tasks and runs the reminders. You can also open the app to fill in a form or drag tasks into the order you want.

**Get started: [download and open the app](#download--install) → [install the Skill](#install-the-skill) → tell your Agent what needs doing.**

## A clear view of today

Tasks created by your Agent appear in the panel. Start with the next suggestion, then see the rest of today's plans. Open a task to see its notes, project, estimate, and deadline together.

<p align="center">
  <img src="assets/readme/en/dial.png" width="100%" alt="The Dial design language: a graphite header tile with a large wide numeral and dot tabs, a frosted Next tile with a dotted progress gauge, a graphite task list, the notch reminder cue, the notch quick look, and signal-orange components.">
</p>

**Dial** is TodoCue's design language: graphite tiles for what you read at a glance, frosted tiles for what you act on, wide numerals, and a single signal orange. The tiles sit together in one tray — Liquid Glass on macOS 26 — so the panel reads as a single object on any wallpaper. Finishing a task draws its checkmark and advances the dotted gauge; reminders drop from the notch with a soft ripple. **The app supports English and Simplified Chinese**—switch in Settings and your choice takes effect immediately. Resize the panel from 300 to 600 points; TodoCue remembers its width.

## Prefer a form? It's still here.

Away from an Agent conversation, type a task title at the bottom of the panel and press Return to add it to today. Choose **Add details** to fill in a project, priority, time, reminder, or repeat rule. Your existing text stays in place.

Drag the empty area in the top bar to move the panel; dragging in titles and notes selects text. Back keeps drafts, with new tasks and each task’s edits stored separately. If a task changes elsewhere, the editor keeps your input and offers an explicit reload of the latest task.

- **See what you finished.** Completed work is kept: open Completed from the panel menu, or from the day's completed list, to review by day and search back through it. Reopen anything with one click.
- **Look further ahead.** Open the calendar from the panel header (⌘⇧K) to see what you have done, what is in flight, and what is scheduled months out. Switch between a month grid and a week list; pick a day to work through it. Drag a task onto another day to reschedule it — the time of day is kept, the deadline and reminder are not touched — and add straight to the day you are looking at. Repeating tasks beyond the 30-day generation horizon show as not-yet-created placeholders rather than an empty month.
- **Legacy v0.5.3: carry it to your iPhone.** Turn on **Sync to Calendar** or **Sync to Reminders** in Settings and dated tasks appear in a "TodoCue" calendar or reminder list that iCloud brings to your iPhone. Changes go both ways: reschedule, rename, or check off there and TodoCue follows; deleting an item deletes its task. Reminders alone is the recommended setup — dated reminders also appear in Calendar on iOS 18 and macOS 15. Sync runs while the app is open and adds no alerts of its own. [Details (中文)](docs/apple-sync.md)
- **Reorder as you go.** Drag a task and its neighbors move out of the way. Move between projects in All or dates in Upcoming; reorder within a group in Today. Undo a move or restore automatic sorting.
- **Choose your language.** English and Simplified Chinese are available in Settings. The first launch follows your system language, with English as the fallback. Task content stays in its original language.
- **Keep it close.** A shared React/Tauri floating panel with native system effects in light and dark appearances. Graphite tiles stay dark; frosted tiles follow your system and blur the desktop behind them.
- **Preferences, organized.** General, Notch, Alerts and Data tabs use consistent switches, sliders and selectors, with light/dark appearance and keyboard support. Changes save automatically.
- **A glance at the notch.** A virtual notch at the top of the screen shows the remaining count. Hover to expand today's tasks, then complete, snooze, reschedule, or add a task. Click to pin and type; Esc collapses it. In Settings → Notch, choose top, left or right docking. On a notched Mac, the band sits at the screen’s top edge with an empty camera spacer and the icon and task count on either side. Each wing uses just 22 pt, and the total stays within the original 273 pt maximum (229 pt with a 185 pt camera housing). On other displays it keeps that width and sits in the menu bar: centered when that space is free, otherwise right beside the menu bar icons without covering any, and below the menu bar only when there is no room. Follow the pointer or pin it to a detected display; if disconnected, it temporarily uses the main display and returns when reconnected. macOS remembers the display UUID. Turn it off in Settings if unneeded.
- **Reminders that follow through.** Repeat tasks, set reminders, snooze, and undo completion. Closing the panel leaves the background reminder service running.
- **Your data stays yours.** Tasks live in `~/.todocue/todocue.sqlite`. Replacing, removing, or reinstalling the app keeps that directory intact.

## Small reminders, on your schedule

Ask your Agent: “Remind me to move every half hour on Monday, Wednesday and Saturday, 9 AM–6 PM.” The Skill creates one periodic rule in one call and reports its schedule and next reminder. To create directly, choose **New periodic reminder** in the panel menu, pick Move / Water / Custom, and click the interval, days or time window. More settings stay folded until needed.

Choose fixed time slots or count from each confirmation. Unanswered completion-based reminders wait until you respond, then reset on the next active day. Pause a rule or just pause today. Periodic rules create no pending tasks and never sync to Apple Calendar or Reminders. They use silent notch cards on your current screen, with system-notification fallback when no card can appear; sleep/offline reminders are skipped. A card stays on the notch until you complete, snooze or pause it; several wait in one stack, and a rule that comes round again before you answer adds a ×N instead of another row.

```bash
todocue --json periodic add 'Move a little' --every 30m --weekdays mon,wed,sat --between 09:00-18:00 --idempotency-key 'YOUR_UNIQUE_KEY'
```

[API and timing details](docs/api.md#periodic-reminders) · [Agent Skill guide](skills/todocue/references/periodic-reminders.md)

## Download & install

Current version: **[v0.6.0](https://github.com/NanmiCoder/TodoCue/releases/tag/v0.6.0)**. Supports **macOS 14+**, **Windows 10/11 x64**, and **Windows 11 ARM64**. Both Mac architectures are Developer ID signed and Apple notarized; Windows installers are unsigned.

| Computer | Installer |
| --- | --- |
| Apple Silicon (M series) | [Download ARM64 DMG](https://github.com/NanmiCoder/TodoCue/releases/download/v0.6.0/TodoCue-0.6.0-macOS-arm64.dmg) |
| Intel Mac | [Download Intel DMG](https://github.com/NanmiCoder/TodoCue/releases/download/v0.6.0/TodoCue-0.6.0-macOS-x64.dmg) |
| Windows x64 | [Download x64 installer](https://github.com/NanmiCoder/TodoCue/releases/download/v0.6.0/TodoCue-0.6.0-Windows-x64-setup.exe) |
| Windows ARM64 | [Download ARM64 installer](https://github.com/NanmiCoder/TodoCue/releases/download/v0.6.0/TodoCue-0.6.0-Windows-arm64-setup.exe) |

Open the DMG → drag **TodoCue.app into Applications** → launch it from Applications.

The app bundles Node, the background service, CLI, notification helper, and Agent Skill. No separate runtime installation is needed. Allow notifications in Settings when you want reminders — macOS asks only once, so if you declined before, enable TodoCueNotifier under System Settings › Notifications (the app's 打开系统设置 button takes you there). To update, quit the old app, replace it with the new one, and reopen it. In-app automatic updates are not yet available.

[Checksums](https://github.com/NanmiCoder/TodoCue/releases/download/v0.6.0/SHA256SUMS) · [Installation, backup, and removal (中文)](docs/macos-install.md)

Windows: choose `Windows-x64-setup.exe` or `Windows-arm64-setup.exe`. The current-user installer includes offline WebView2 and the runtime. Windows packages are unsigned; verify `SHA256SUMS` from the release. Quit and uninstall an older Preview before installing the production client; task data is retained.

## Install the Skill

Install and open TodoCue once, then use the [Skills CLI](https://github.com/vercel-labs/skills) to install the Skill for your local Agent. This command requires Node.js / npx. Follow the prompts to select Claude Code, Codex, Cursor, or another supported client:

```bash
npx skills add NanmiCoder/TodoCue --skill todocue -g
```

For WorkBuddy or clients not listed by the installer, import the repository's [`skills/todocue`](skills/todocue) directory using the client's custom Skills setup. See [WorkBuddy's custom Skills guide](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Practice-Cases/Create-Skills) and the [Skills CLI supported agents](https://github.com/vercel-labs/skills#supported-agents).

Then ask: “Use TodoCue to add a task to summarize this week's progress, plan it for today, put it under Work, and estimate 25 minutes.” Keep using natural language to query, reschedule, set reminders, and complete tasks.

The Agent must have access to the same computer where TodoCue is installed and permission to run local commands. Loading the Skill in a remote or cloud-only environment does not give it access to this computer's tasks. The app's quick-add field saves a task title; dates and reminders can be set in the form.

MCP is an optional entry point via `todocue mcp`. For custom integrations, see the [Local API documentation](docs/api.md).

<details>
<summary><strong>Build from source & contribute</strong></summary>

Requires Node 24+ and Rust 1.90+. Mac builds need macOS 14+ and Xcode 26 / Swift 6; Windows builds need MSVC C++ tools and the Windows SDK.

```bash
npm ci
npm run build
npm test
swift test --package-path apps/macos
npm run desktop:macos
```

The shared DMG is written to `apps/desktop/build/`. On Windows use `npm run windows:build` on the matching architecture. Local packaging downloads and verifies a pinned official Node runtime, installs locked production dependencies, and checks that the bundled Node, SQLite, and MCP run correctly.

| Path | Responsibility |
| --- | --- |
| `apps/macos` | Legacy SwiftUI / AppKit client and current Mac notification helper |
| `apps/desktop`, `packages/client` | Production Tauri 2 frontend and portable client |
| `packages/engine` | Task rules, recurring occurrences, reminders, and SQLite |
| `packages/server` | Local API, authentication, and SSE updates |
| `packages/cli`, `packages/shared` | CLI / MCP interfaces and shared contracts |
| `skills/todocue` | Distributable Agent Skill |

Use `npm run dev:serve` for development and `TODOCUE_HOME` to isolate development data. Pushing a `vX.Y.Z` tag triggers GitHub Actions to build, sign, notarize, and release both Mac and both Windows architectures.

[Release guide (中文)](docs/github-release.md) · [Implementation and QA (中文)](docs/implementation-plan.md) · [Open an issue](https://github.com/NanmiCoder/TodoCue/issues)

</details>

The shared desktop client is now the production build. Use `npm run desktop:dev` with isolated data for development. The `Release desktop (Mac and Windows)` workflow checks all four installers before publication. [Setup](apps/desktop/README.md), [migration/QA status](docs/desktop-migration.md), and [handoff](docs/desktop-handoff.md) distinguish tested behavior from outstanding hardware acceptance. Earlier preview evidence remains in [UI comparison](docs/qa/desktop-p1-ui/README.md), [independent review fixes](docs/qa/desktop-review-fixes/README.md), and [offline startup fix](docs/qa/desktop-macos-runtime/README.md).

## License

[MIT](LICENSE) © 2026 NanmiCoder. Contributions welcome.
