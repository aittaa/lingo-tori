# LingoTori bird identity

LingoTori's selected mascot is candidate A: the newly generated white long-tailed tit with a round cream body, dark teal eyes and beak, a teal wing, and a long tail rising to the right. The original raster is retained unchanged in [LingoTori-A-long-tailed-tit.png](./LingoTori-A-long-tailed-tit.png).

## Provenance and licensing

- Selected Library item: `libfile_2e13dce9f7708191a2a2c84245b41fb0`, version `0`.
- Original file ID: `file_0000000030a081f59745c9b66843e91f`.
- Original filename: `LingoTori-A-long-tailed-tit.png`; 1254 × 1254 RGB PNG.
- Original SHA-256: `786efd1716b64ab851bd8e70c37527d364f80d06dbd90eaedd29ec055c65b313`.
- Selection instruction: “A로 가자 테마도 이거따라가도록”.
- Generation provenance: newly generated for LingoTori with OpenAI image generation. The original prompt and exact generation model were not included with the supplied reference; neither is inferred here.
- Production refinement: Codex drew original SVG paths from the inspected selected raster. No previous unknown-origin icon or outside icon artwork was reused.
- These source assets and modifications are distributed with LingoTori under GPL-3.0. See [LICENSE](../../LICENSE) and the preserved upstream attribution in [public/NOTICE.txt](../../public/NOTICE.txt).

## Production assets

[lingotori.svg](../../src/assets/icons/lingotori.svg) keeps the round white body, teal wing, dark eyes, and long right tail while adding an outline for light surfaces. [lingotori-compact.svg](../../src/assets/icons/lingotori-compact.svg) removes toes, glints, and the wing detail and strengthens the outline and eyes at 16 and 32 pixels. Both fit inside the existing circular image masks.

The transparent 256-pixel `src/assets/icons/lingotori.png` supplies the popup, floating button, side panel, and existing subtitle button. The extension continues to use the same public icon paths and sizes. The active 16/32/48-pixel variants add a cream check on a teal disc, retaining a shape cue for the enabled translation state.

Regenerate with Node.js and Sharp **0.35.5** in an isolated tools directory; Sharp is a design tool, not an extension runtime dependency:

```sh
npm install --prefix /tmp/lingotori-brand-tools --ignore-scripts --no-audit --no-fund sharp@0.35.5
node scripts/generate-brand-icons.mjs /tmp/lingotori-brand-tools/node_modules/sharp/dist/index.cjs
```

The generator renders the SVG sources directly to PNG. It never edits the retained original raster.

## Theme

The compact palette in `src/assets/styles/host-theme.css` is shared by `theme.css` and raw translation-preset styling. It remains import-free because constructable stylesheets consume the preset CSS as text. Existing `--rf-*` semantic names, `--read-frog-*` preset names, theme mode selection, and saved custom CSS remain intact.

| Role                   | Light               | Dark                   |
| ---------------------- | ------------------- | ---------------------- |
| Background             | Cream `#fcfaf2`     | Deep teal `#102c33`    |
| Card / popover         | Feather `#fffdf7`   | Teal surface `#18373e` |
| Text                   | Ink `#103e49`       | Feather `#fffdf7`      |
| Brand / accent / links | Deep wing `#1d626b` | Mint wing `#88c5c4`    |
| Solid accent labels    | Feather `#fffdf7`   | Deep teal `#102c33`    |
| Muted text             | `#536862`           | `#c6d5cf`              |

Deeper teal is used for small labels on cream; the original brighter wing colour remains in the mascot. Brand and accent buttons share hover, pressed, and bevel tokens. Existing status hues, typography, layout dimensions, radii, animations, actions, and configuration schemas are retained. Dark switches use the accent foreground for their thumb, and outline accent buttons follow the readable accent text colour in both modes.

## Review gate

Offline review covers the original and refined pixels, transparent icons at 16/32/48/96/128 pixels on light and dark backgrounds, circular masks, compiled CSS, and representative shared controls in both modes. A token/control preview is design evidence, not a built-extension runtime demo.

A Chrome production build passed with a 2048 MiB Node heap cap. The final muted-text refinement was then validated with the repository PostCSS pipeline and offline contrast measurements; a fresh production build remains part of the merge gate. Before merging, obtain a serialized production-build slot, inspect the actual popup/options/floating UI in an isolated profile, and run the relevant existing checks with `SKIP_FREE_API=true` and at most two test workers. Tests are reserved for immediately before merge per `AGENTS.md`; a draft PR does not run or dispatch CI. Explicit user confirmation is required immediately before merging.
