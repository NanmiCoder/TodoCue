# README art direction · 2026-09-07

## Product story

- **Audience:** macOS users who want a quiet task companion, including people working with local coding agents.
- **One-sentence value:** You and your agents manage the same local tasks through a native floating panel, CLI or MCP.
- **Primary proof:** Computer Use captures of the real SwiftUI / AppKit app: Today, task detail, quick input and the expanded form.
- **First successful action:** Download the signed DMG, drag TodoCue into Applications, then add one task.
- **Visual theme:** The app's open-ring cue, forest green, mint and warm glass.

## Visual system

- Palette: warm white `#F6F8F5`, forest green `#086E59`, mint `#7BD9BD`, charcoal `#252D2A`, muted sage `#778780`.
- Typography: restrained sans-serif in the hero; GitHub's native system typography for searchable, selectable body copy.
- Shape: the app's rounded glass panel and open circular cue. No extra decorative frames around screenshots.
- Motif: the open C-shaped ring and its dot, paired with an unfinished / finished checkbox.
- Composition: quiet product illustration first, full readable native windows immediately after the introduction.

## Assets and provenance

| Asset | Source | Size / use |
| --- | --- | --- |
| `assets/readme/hero.webp` | Built-in `image_gen`; 3D brand illustration, not an app screenshot | 1774 × 887, WebP quality 90, about 107 KB |
| `assets/readme/today-light.png` | Computer Use `App.getScreenshot()` | 390 × 680, real light-mode Today view |
| `assets/readme/task-detail-dark.png` | Computer Use `App.getScreenshot()` | 390 × 680, real dark-mode task detail |
| `assets/readme/quick-add-light.png` | Computer Use `App.getScreenshot()` | 390 × 680, real quick-entry state |
| `assets/readme/task-form-light.png` | Computer Use `App.getScreenshot()` | 390 × 680, real expanded form |

The screenshots use an isolated demo runtime and fictional tasks. They preserve the app's actual layout, text, focus indicators and Computer Use pointer. No generated UI replaces screenshot content. Capture builds use the repository's debug executable with per-process appearance overrides; the user's installed app and task database are unchanged.

Screenshots are embedded at 390 pixels each and can wrap onto separate lines on narrow pages. Each image links to its original through GitHub's Markdown rendering. The generated art is explicitly described as an illustration in its alt text; essential product claims and installation commands remain in Markdown.

## Final image prompt

Built-in image generation was used; no CLI fallback.

> Use case: stylized-concept. Asset type: wide GitHub README hero for TodoCue, a native macOS local-first todo app for people and coding agents. Create an exceptionally refined editorial 3D product-brand hero, landscape 3:1 composition, 1800 by 600 or similar. Warm porcelain off-white #F6F8F5 background, forest green #086E59 lettering and accents, soft mint #7BD9BD translucent glass, a trace of warm champagne reflected light. Left 43%: large beautifully typeset exact title 'TodoCue' in a calm modern sans-serif, dark forest green. Under the title, smaller exact text 'A little cue. A clearer day.' One small uppercase eyebrow above title: 'NATIVE macOS · LOCAL FIRST'. Right 57%: a sculptural physical reinterpretation of TodoCue's real logo, an open thick C-shaped rounded ring with opening facing right, and one small separate round dot inside the opening to the right of center. The C and dot are forest-green translucent cast glass standing over a pale mint frosted rounded-square base. Behind and gently overlapping it are TWO slim floating rounded glass task slips, each with a single delicate circular checkbox and short embossed horizontal strokes, one checkbox ticked and one still open: these should read as sculptural representations of to-dos, not fake screenshots. The geometry of the open C cue and the transition from unchecked to checked are the key brand-specific motifs. A compact milky glass capsule with a subtle terminal >_ symbol near the base suggests agent/CLI access to the same task list; subordinate to the main logo. Precision industrial design, soft studio daylight from upper left, tactile glass refraction, thin bright edges, realistic gentle contact shadows, sophisticated depth with restrained perspective, all objects clearly separated. Composition must feel tranquil, focused, and distinctive. Plenty of whitespace and legible typography, no dense UI, no laptop or phone device frame, no generic AI brain, no chrome robot, no purple/blue neon, no gradients used as decoration, no busy background, no extra words or watermark. This is a conceptual brand illustration; actual unaltered app screenshots will be displayed immediately below it in the README.

## Validation

- README rendered through GitHub's Markdown API and previewed with GitHub's own stylesheets.
- Wide and narrow viewport checks, light and dark page backgrounds.
- All five local image references pass the skill's README audit.
- Source version contract remains `v0.1.0`; license metadata is MIT across workspace manifests and lockfile entries.
