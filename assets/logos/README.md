# Logos

`grok.png` and `claude.png` are the official vendor marks for **Grok** (xAI) and **Claude**
(Anthropic), unmodified copies of the vendors' published logo files. They are used only to
identify which CLI produced a run card (nominative use). This project claims no ownership of,
or affiliation with, these trademarks; all rights belong to their respective owners.

At render time `src/cards/logo.js` decodes the PNG with the built-in decoder
(`src/cards/png.js`), scales it into a rounded tile on the card's left column, and clips the
corners. Tile colour and padding come from `logo` in `src/cards/themes.js`.

To swap a logo, replace the PNG (8-bit greyscale/RGB/RGBA/palette, non-interlaced, square) and
run `npm run preview` to check the result. There's no build step.
