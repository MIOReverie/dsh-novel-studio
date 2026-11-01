# Moshu · Novel Studio for DSH

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.5%2B-blue.svg)](https://www.npmjs.com/package/@deepseek-ai/dsh-harness)

**English** · [简体中文](README.md)

**An AI assistant for people who write novels themselves.**

Moshu is not an "AI continues your novel" generator. It assumes the author has the ideas and writes
the prose, while the AI takes the chores that actually drain people: turning details scattered through
the manuscript into reference files, catching contradictions, keeping the timeline and world map in
sync, reminding you which chapter still has no outline.

> **The pen stays in your hand; the AI does the remembering and the proofreading.**
> It will not produce your next paragraph, chapter or plot beat — that boundary is by design.

## What it does / does not do

| Does not | Does |
|---|---|
| ❌ Continue the story, ghost-write prose | ✅ Read what you wrote and maintain character / location / faction / world files |
| ❌ Decide where the plot goes | ✅ Flag contradictions, inconsistent terms, broken timeline — with the chapter and sentence |
| ❌ Fill the book with template text | ✅ Horizontal swimlane timeline (main / hidden threads, plot web), six-layer world map, structured chapter outlines |
| ❌ Change your draft silently | ✅ **Every prose edit needs your approval**; reference files are free to edit, but only facts that exist in the book |
| ❌ Make you juggle ten tools | ✅ One page for prose, outline, references, map, timeline, memory, tasks |

Three hard rules:

1. **Prose belongs to the author.** The AI can only touch it through `novel_edit_chapter`, which always
   asks you first; batch edits ask **once** for the whole set.
2. **No invented canon.** If the text does not say it, the file says "not stated in the text".
3. **No work-log prose.** Documents hold facts, never "added in this session" changelogs.

## Shape

A **full-page plugin inside DSH (DeepSeekRuntime) Web**. Open the workbench from the conversation
tab, write on the left, let the AI manage references on the right. There is **no separate service**:
the backend runs inside the DSH process (`/api/moshu/*`) and models go through DSH's `ctx.llm` — no
Express/Vite sidecar, no token pasting.

## Install

**Requires** DSH `0.2.1-rc.5` or newer.

1. Clone this repository (or download the zip from Releases).
2. Copy `dsh-plugin/moshu-novel-studio` into your DSH profile's `node_modules/` as
   `node_modules/@local/moshu-novel-studio` (or rename the scope; then update `name` in that
   package's `package.json` **and** in `cordis.patch.yml` — both must match).
3. Add the plugin row from `dsh-plugin/moshu-novel-studio/cordis.patch.yml` (the `insert` block, which
   also declares the "创作模式" agent preset) to that profile's `cordis.patch.yml`.
4. Restart DSH. The Moshu tab appears in the conversation view.

`client.js` is committed, so **no build step is needed**. To rebuild from source:

```bash
npm install          # only @babel/core and preset-react
npm run build:plugin # regenerates dsh-plugin/moshu-novel-studio/client.js
```

## Features

- **Writing**: Markdown body, line numbers, reading preview, autosave, version history and restore.
- **Chapters**: create / rename / reorder / delete; titles live in `chapters.json`, never inside the prose.
- **Outline**: volumes and chapters with goal / conflict / scenes / hook, beats, thread (main·sub·hidden),
  status — edited in place, saved as one structured `outline.json`.
- **World map**: six layers (landmasses, biome areas, stamps, polylines, pins, decorations), all drawable
  by AI; biome paint is clipped to the coastline and auto-scattered with matching symbols.
- **Timeline**: horizontal swimlanes, main vs hidden threads, events linked into a plot web
  (cause / impact / foreshadow); events are extracted from the prose, never fabricated per chapter.
- **References**: characters, locations, factions, world, outline, memory, clues — AI maintains them,
  prefers editing the existing file over creating parallel ones.
- **Approval model**: prose writes always ask; batch writes ask once; reference writes are free.
- **Focus mode**: hide top bar + chapter rail + info bar with one key (`Ctrl+Shift+F`, `Esc` to exit).

## Data and safety

- **No story data in this repository**: `.moshu/` (per-user library + local settings) and `novels/` are gitignored.
- Books live in `<workspace>/.moshu/novels/<book>/` — one workspace serves one novel, so every
  conversation in that workspace sees the same shelf. Older layouts are migrated automatically
  (files are copied, originals kept).
- Every save is backed up under `.backups/`; deletes go to `.trash/` first.
- Writes carry the book identity (`X-Moshu-Book`), so a request from the moment you switched books
  can never land in the wrong one.

## License

MIT — see [LICENSE](LICENSE).
