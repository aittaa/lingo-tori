# Embedded example and default text audit

Scope: issue #46, reviewed against `628a67e61a46303c54b2250b1a85d461a46d143d` on 2026-10-12. Chinese UI availability and Chinese source-text translation remain supported; upstream UI-locale restoration (#45) is separate. Han-character searches were candidate discovery only; each result was classified in its source context.

## Changed surfaces

| Surface                                   | Source                                                                             | Result                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Page translation style preview            | `src/entrypoints/options/pages/translation/translation-style/style-preview.tsx`    | Korean reading sentence with `lang="ko"`                                       |
| Custom CSS preview controls               | `src/entrypoints/options/pages/translation/translation-style/custom-css/index.tsx` | Same Korean sentence; initial language control is `ko`                         |
| Built-in site-rule help and expanded JSON | `src/utils/site-rules/built-in/rules.json`                                         | Korean descriptions for the 12 rule IDs below; all other rule fields preserved |

The rule IDs are `primevideo`, `janitorai`, `cnn`, `hbomax`, `hulu`, `tandfonline`, `balthild`, `nexusmods`, `toneking`, `dynamic-repets`, `fix-header`, and `alibaba-sourcing-rfq`. `BuiltInRuleRow` displays each description beside the rule ID and in its expanded JSON. URLs, selectors, matches, IDs, CSS, and translation behavior are unchanged.

The owner-reported sentence beginning `神谷先生` was already removed by `b75c8ac8`. That commit replaced the page-style sample with Japanese and the subtitle pair with the current English/Korean reading example. This change makes the successor page-style sample Korean; it does not reconstruct or translate the removed quotation.

## Inspected surfaces already suitable

- `subtitles-preview.tsx`: English source “Reading in a new language opens up a little more of the world.” and Korean translation “새로운 언어로 읽으면 세상이 조금 더 넓어집니다.”
- `reading-tools-preview.tsx`: labels resolve through the selected UI locale; no embedded Chinese example.
- `src/utils/layout-host/sample.ts`: new sample values are empty; existing user sample data is preserved.
- EN/KO dictionary prompt examples: the English `blossoms` example already targets Korean; the Japanese `感動` example intentionally targets English.
- Current README, help/settings documentation, and context-menu illustration: no Chinese default/example prose found.
- All 19 tracked PNG/SVG assets under `public/` and `src/assets/` were visually inspected (10 PNGs, 9 SVGs). Bird/guest/provider icons contain no Chinese sample text; `context-menu.svg` contains three English labels. Tensdaq SVGs render Latin lettering. No screenshot/sample asset requires replacement under this issue.

## Deliberate exclusions

| Retained content                                                                                      | Reason                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Chinese input and `cmn` output in `src/utils/prompts/language-detection.ts`                           | Language-recognition example with a matching code/output contract; changing the model-facing example requires a separate behavior decision |
| `犹豫` / `葡萄` in dictionary prompt guidance                                                         | Real lexical examples constrain incorrect character splitting; substituting Korean would change the instruction's meaning                  |
| Japanese catalogue, `感動`, `日本語`, and Japanese subtitle segmentation examples                     | Japanese language support and purposeful source-language examples, not Chinese defaults                                                    |
| `src/utils/config/migration-scripts/`, config snapshots, and changelog/history                        | Frozen compatibility data and historical records; rewriting these could change migrated user data                                          |
| Multilingual tests in host/translation, subtitles, glossary, language detection, and form composition | Exercise CJK boundaries, IME composition, language routing, source/target relationships, and restoration behavior                          |
| Developer comments/debug messages and font names                                                      | Outside embedded user-facing default/example prose scope                                                                                   |
| Tensdaq SVG `图层_1` IDs                                                                              | Invisible authoring metadata; commercial cleanup is separately owned by #34                                                                |
| Licenses, notices, attribution, language codes, and persisted user content                            | Required legal provenance, supported Chinese capability, and user-data preservation                                                        |

## Verification and merge gate

Offline production builds of the base and candidate were inspected in separate fresh headless Chrome profiles at 1280 × 800. Rendered iframe/shadow-root text and screenshots confirmed the page-style sample, matching custom CSS language control, subtitle source/translation pair, and searched `primevideo` rule description. Both runs had zero page errors and made no external translation requests. A structural comparison of all 484 rules confirmed that only the 12 descriptions changed.

The repository rule defers tests until immediately before merge. At that gate, set `SKIP_FREE_API=true`, use at most two test workers, run the existing translation/subtitle sections and site-rule tests, and rerun `scripts/audit-ui-resources.mjs --base 628a67e61a46303c54b2250b1a85d461a46d143d`. Review any future embedded sample against this inventory instead of enforcing a blanket Han-character prohibition.
