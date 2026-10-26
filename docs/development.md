# Development

[← Back to the README](../README.md)

```bash
npm test           # node --test, no install needed
npm run preview    # writes sample grok/claude open + close cards (PNG for every status, plus .md) to ./preview/ (git-ignored; README copies live in docs/screenshots/)
npm run font       # rebuilds src/cards/font-atlas.json (needs python3 + pillow + fonttools)
```

The tests use `tests/fixtures/fake-grok` (modes: pass / fail / json / claude-json / grok-cancelled-json / grok-stream-blocked / grok-stream-edited / claude-denied / claude-stream-denied / claude-max-turns / commit / hang / slow / stdin / args / signal; `FAKE_GROK_MARKER=<file>` records that it was started) as both `GROK_BIN` and `CLAUDE_BIN`, so they never call the real Grok or Claude APIs.

## Font & logos

**Font: pre-rasterized Fira Code atlas.** Card text is [Fira Code](https://github.com/tonsky/FiraCode) (SIL OFL 1.1). Instead of parsing the TTF at runtime (which would need a font engine or native deps), `scripts/build-font-atlas.py` uses Pillow + fontTools to rasterize printable ASCII plus `…` and `·` at the three text sizes the cards use (20 / 30 / 40 px; regular 450 and bold 600 weights) into anti-aliased 8-bit alpha bitmaps. They're stored deflated in `src/cards/font-atlas.json` (~100 KB), which **is committed**, so `npm test` and card rendering need no build step and no Python. `src/cards/font.js` loads the atlas and `Canvas#text` alpha-blends the glyphs. Fira Code is monospace (advance = 0.6 em), so layout stays fixed-cell. Ligatures aren't used: glyphs are drawn one by one.

- Font files: `assets/fonts/FiraCode-VariableFont_wght.ttf` + `assets/fonts/OFL.txt`, bundled so the atlas can be rebuilt anywhere.
- Rebuild the atlas (only needed if you change sizes, weights, characters or the font): `pip install pillow fonttools`, then `npm run font`.
- Characters outside the atlas are folded before drawing (smart quotes → ASCII, `✓` → `v`, …, else `?`). See `toCardText` in `src/cards/render.js`.

**Logos: official vendor marks.** `assets/logos/grok.png` and `assets/logos/claude.png` are the official Grok (xAI) and Claude (Anthropic) logos. They're used only to identify which CLI produced a card, and this project claims no ownership of those trademarks (see [`assets/logos/README.md`](../assets/logos/README.md)). `src/cards/logo.js` decodes them with the built-in PNG decoder (`src/cards/png.js`), area-resamples them to tile size, and clips them to a rounded tile whose colour and padding come from `logo` in `src/cards/themes.js`.

## Layout

```
bin/run-cards              CLI entry (#!/usr/bin/env node; carries the wrapper marker)
src/cli.js                 arg handling, open → run → close orchestration
src/passthrough.js         spawn + live tee + bounded capture + timeout / signal handling
src/discover.js            real-binary discovery that skips the wrapper
src/mask.js                secret masking
src/usage.js               JSON/NDJSON token + final-text extraction (shared by adapters)
src/outcome.js             cancelled / blocked / no-edit detection (shared by adapters)
src/git-info.js            repo / branch / new-commit lookup for the .md cards
src/run-dir.js             run directory, cards, sidecar, latest.json
src/adapters/grok.js       Grok Build adapter
src/adapters/claude.js     Claude Code adapter
src/cards/contract.js      OpenCardFields / CloseCardFields builders (shared contract)
src/cards/render.js        card layout → PNG (swap this seam for sharp/resvg later if wanted)
src/cards/markdown.js      open.md / close.md text cards for text-only rooms
src/cards/canvas.js        rasterizer: SDF shapes, atlas text, image blits
src/cards/png.js           PNG encoder + decoder + resampler
src/cards/font.js          Fira Code atlas loader (font-atlas.json is generated + committed)
src/cards/{logo,themes}.js official logo tiles, brand themes
assets/logos/              grok.png, claude.png (official marks) + README.md
assets/fonts/              FiraCode-VariableFont_wght.ttf + OFL.txt
scripts/                   install.sh (install/update), build-font-atlas.py (npm run font), preview-cards.js (npm run preview)
tests/                     node:test suites + fixtures/fake-grok (doubles as fake claude)
```

## Out of scope (v1)

- Uploading cards to chat automatically
- Publishing to npm
