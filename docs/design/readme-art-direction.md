# README art direction · 2026-09-08

## Product story

Agent conversations are the primary entry point: capture an action item, manage it with natural language through Skills, and see it in TodoCue on the Mac. Forms and drag sorting remain available. The default README is English; `README.zh-CN.md` contains the complete Chinese version.

## Assets and provenance

| Asset | Source | Resolution |
| --- | --- | --- |
| `assets/readme/hero.webp` | Existing generated brand illustration, not a UI screenshot | 1774 × 887 |
| `assets/readme/en/*.png` | Four fresh English native panel captures | 840 × 1360 |
| `assets/readme/zh-CN/*.png` | Four fresh Chinese native panel captures | 840 × 1360 |
| `assets/readme/demo/alpine-lake.png` | Generated fictional hiking moodboard photo | 1536 × 1024 |
| `assets/readme/demo/forest-trail.png` | Generated fictional hiking moodboard photo | 1536 × 1024 |

Each language includes Today, a dark task detail with two image attachments, quick add with a title, and the expanded form with the same title. Tasks and projects are written in the corresponding language. The app screenshots are real SwiftUI / AppKit panels, never generated UI.

## Capture procedure

After building the runtime, run on macOS with screen capture permission:

```bash
npm run build
node scripts/readme-screenshots.mjs "$PWD/assets/readme/demo/alpine-lake.png"
```

The script creates fresh temporary databases for both languages, seeds fictional but realistic tasks and attachments using TaskEngine, and starts random-port runtimes with MemoryNotifier. It then invokes the opt-in `ReadmeScreenshotTests` harness. This harness is skipped in ordinary tests and CI.

ScreenCaptureKit includes only the native panel and its own neutral backdrop, cropped to the panel at 2× resolution. `showsCursor` is false; all other windows are excluded, including computer-use pointer overlays. The capture keeps the app's real layout and typography, without painting over screenshot pixels. Focus is cleared before capture so no insertion caret appears.

The user's installed app, runtime, notification settings, and task database are not used. Language and window preferences are isolated too. Demo task titles, notes, and images are not copied from personal data.

## README presentation

The original PNGs are embedded at 390 pixels wide. Each README uses only its matching language folder. Alt text describes the visible content; the prose explains that these are demo tasks and generated photo attachments. The hero remains a conceptual brand illustration.
