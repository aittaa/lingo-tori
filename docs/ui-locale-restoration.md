# Upstream interface language restoration

Issue [#45](https://github.com/aittaa/lingo-tori/issues/45) lifts the former EN/KO/JA interface restriction. The inventory is pinned to Read Frog commit `55bcef1e684fb4e70f4dce3063e7bd3066f46891`, fetched on 2026-10-12; its `src/locales/` directory, runtime list and selector contain exactly `az`, `en`, `es`, `ja`, `ko`, `ru`, `tr`, `vi`, `zh-CN`, `zh-TW`. LingoTori base is `462a5a50d6812ce5ae91204d94a04a914528b101`.

## Restored coverage

The seven restored catalogues reuse upstream strings only when the current English source is unchanged and the key belongs to the retained catalogue. `name` is the proper name LingoTori. Changed descriptions, missing upstream keys and new LingoTori keys deliberately resolve through the existing English i18next fallback. No translations were generated, purchased or submitted to an external service. Reuse and structural checks do not establish linguistic quality; inherited English values are not counted as reviewed translations.

| Interface locale              | Catalogue keys | Retained keys using English fallback | Inherited values identical to English |
| ----------------------------- | -------------: | -----------------------------------: | ------------------------------------: |
| Azerbaijani (`az`)            |          1,054 |                                   85 |                                     5 |
| Spanish (`es`)                |          1,060 |                                   79 |                                    61 |
| Russian (`ru`)                |          1,055 |                                   84 |                                    16 |
| Turkish (`tr`)                |          1,055 |                                   84 |                                    61 |
| Vietnamese (`vi`)             |          1,055 |                                   84 |                                    18 |
| Simplified Chinese (`zh-CN`)  |          1,064 |                                   75 |                                     9 |
| Traditional Chinese (`zh-TW`) |          1,064 |                                   75 |                                     9 |

Counts use the base English catalogue (1,157 keys), exclude the 22 keys being removed by PR #59, and include its four shared replacement keys. Proper-name `name` is excluded from identical-to-English counts. Empty prefix/suffix strings used to assemble localized sentences are preserved; an empty string is not a missing key. Identical values include technical names and inherited English copy and need individual review. Existing English/Korean/Japanese files are unchanged; KO/JA keep their existing two sentence-analysis prompt fallbacks and prior translation-review limitations.

[The machine-readable coverage inventory](ui-locale-coverage.json) distinguishes:

- 60 changed English keys: branding/manifest text, provider descriptions, reading-suggestion wording, removed audio/layout claims and other LingoTori-specific copy.
- Nine new English keys for subtitle copy states. These intentionally use English in all seven restored locales.
- Two sentence-analysis model keys (`systemPrompt`, `prompt`) kept in English by the existing policy. Restored locales also use the current English dictionary system/input prompts, preserving the Korean example instead of bringing back the upstream Chinese example. Existing KO/JA dictionary wording is preserved.
- Actual upstream omissions per locale: template metadata and sentence-analysis field descriptions; some locales additionally lack provider-in-use or subtitle-panel labels.
- 22 pending Hub deletions, separately from untranslated retained copy, and four shared key replacements.

BYOS copy is inline in `src/entrypoints/options/pages/byos/index.tsx`, outside the YAML inventory. Its existing KO/JA/EN selection explicitly chooses English for all seven restored locales. This covers all 34 labels/messages: sign-in/reconnect/retry/cancel; checking/waiting/permission/starting; disconnected/connected/identity/restricted/limit/expired/unavailable; Chromium/denied/failed/ended/background/callback/routing; model/choose/save/saved/sign-out/usage/menu/revoked/signed-out/assigning/details/detailText. This PR does not manufacture BYOS translations or change connection behavior.

## Selection and build paths

The config enum and options selector share `SUPPORTED_UI_LOCALES`, with native-language labels from upstream. Runtime resources explicitly import all ten YAML catalogues. Explicit choices persist without changing translation source/target or provider assignments. Auto resolves exact/prefix matches; Chinese `zh`, `zh-CN`, `zh-SG`, `zh-Hans-*` use Simplified, while `zh-TW`, `zh-HK`, `zh-MO`, `zh-Hant-*` use Traditional. Case and underscore separators are normalized. Unknown browser languages or unavailable browser language APIs use English.

The existing WXT i18n module emits native `_locales/*/messages.json` from the same files; `default_locale` remains `en`. Missing native manifest descriptions use English. Azerbaijani is available through the bundled runtime selector even though Chrome does not recognize it as a native manifest locale; WXT warns about this existing upstream limitation. No locale in the restored set uses RTL script. No plural-form key families are introduced; positional `$1` tokens, named model tokens and Chrome `%s` remain unchanged.

Historical migrations remain frozen. The old v110-to-v111 migration resets non-EN/KO/JA choices to Auto; this PR cannot recover a previously discarded choice. Users can explicitly select a restored language after that migration. Schema version and existing translation languages are unchanged. Korean source defaults, examples and preview data remain unchanged.

## Integration boundaries

No removed commercial/backend, TTS, writing, Study or Hub-only keys are added. Licenses and attribution are unchanged. PR [#59](https://github.com/aittaa/lingo-tori/pull/59) owns deletions from EN/KO/JA and the Hub runtime. The restored files already include only `languageSearch.placeholder`, `languageSearch.noResults`, `translation.failed`, `translation.failedFallback` for shared retained UI; their English reference values are recorded until #59 adds them to EN. Against the pinned base, existing Hub/search/error callers can still fall back to base English; merge #59 before releasing this restoration.

Issue [#47](https://github.com/aittaa/lingo-tori/issues/47) owns the usage page and its new strings. This PR adds no usage-page keys. After integration, record its new English keys as deliberate fallbacks in the inventory and rerun the audit; do not confuse these additions with removed Hub keys. EN/KO/JA YAML files are untouched to limit conflicts with both work streams.

## Local verification and merge gate

The existing read-only `scripts/audit-ui-resources.mjs` now discovers locale files, compares them with the runtime list, and checks documented fallbacks, extra keys, placeholders and model prompt policy. It uses the already installed Vite YAML parser. This is an offline structural audit, with no provider calls or new localization infrastructure:

The inventory also pins a SHA-256 digest for each restored resource: JSON containing the upstream commit, locale and flattened key/value entries sorted by key. The snapshot was compared with the pinned upstream Git objects before recording these digests; only the LingoTori proper name and four documented key moves are permitted differences. The audit checks values as well as placeholders without needing those upstream objects or a network connection. All four shared replacement keys are required even before they exist in English. Formatting/key ordering does not affect the digest. An intentional translation update requires source review and an explicit inventory update; this detects snapshot drift, not linguistic quality or coordinated edits to both resource and inventory.

```sh
SKIP_FREE_API=true node scripts/audit-ui-resources.mjs --base 462a5a50d6812ce5ae91204d94a04a914528b101
```

Static preparation passed with the installed Node 26.11.1 dependencies: the offline audit, WXT 0.21.4 `prepare` (Azerbaijani warning above), TypeScript `tsc --noEmit`, oxlint `--type-aware --type-check --threads=2`, changed-file formatting and Changesets status. This new changeset requests a patch for `@lingotori/extension`; the repository's aggregate pending release remains minor because of existing changesets. Every restored leaf was also compared with the pinned upstream source: only the LingoTori proper name and the four key moves differ.

Static length inspection found 18 Azerbaijani, eight Spanish, seven Russian, two Turkish and two Vietnamese single-line labels longer than twice their English counterparts (English length 10–65 characters); neither Chinese catalogue met that filter. For example, the config-backup title expands from 13 English characters to 32 Azerbaijani, 35 Spanish and 34 Russian characters. This is a layout-review list, not a clipping assertion. The selector uses the existing scrollable select surface.

At initial PR creation, catalogue and language-selection regression coverage was prepared but tests/builds were NOT RUN under AGENTS.md. The coordinator subsequently explicitly requested the pinned-head test/build validation below. Browser layout, language-review quality, browser installation and live-provider behavior remain unverified. Initial memory showed 35% available with substantial compression; static tools used a 3 GiB Node heap cap and two lint threads.

Immediately before an explicitly confirmed merge, the coordinator should run the relevant suites with `SKIP_FREE_API=true`, limit workers to two and disable file parallelism, then perform the final static/build/browser checks on the integrated candidate. Suggested targeted suites: `src/utils/i18n/__tests__`, `src/utils/constants/__tests__/sentence-analysis-prompt.test.ts`, `scripts/audit-ui-resources.test.ts`, `src/utils/config/__tests__`, and BYOS settings tests. Full retained-feature regressions, Pro review, CI, installed-browser evidence and merge remain coordinator-owned.

## Coordinator-requested follow-up validation (2026-10-12)

The initial review head was `fd3d301055e5c3e40926c680d8412d5184f2a7b3`. Its initial targeted run executed 79 tests: 64 passed and 15 failed. Fourteen failures came from the Auto-language test mocking `#imports` while WXT rewrites that import before Vitest mocks it; the language stub did not reach WXT's fake-browser instance. The remaining failure exposed an offline-audit gap: placeholder changes in a locale absent from the base were recorded without causing a failing exit status.

The validation correction, published as `2f46bd83e0c59dccbf9e7380aeeb6fa329dcb380`, installs the language stub on the actual fake-browser instance and treats mismatched placeholders in previously absent keys as regressions. It adds seven BYOS sign-in fallback cases without starting authentication. No runtime feature code, stored data, EN/KO/JA wording, examples or preview data is changed by this correction. Corrected targeted suites passed 79/79, and BYOS settings/fallback coverage passed 34/34 (113 distinct tests across five files). Changed validation files passed targeted type-aware lint; prior general audit/type/lint checks were not repeated.

The exact original PR head built successfully for Chrome MV3 and Firefox MV3, sequentially (WXT-reported total 16.90 MB each). A local candidate combining that head with PR #59 head `c4c025b83061928528cb2d1db9c3eb58ca275b69` has one textual conflict in `src/types/config/config.ts`: preserve the #59 `legacy-config` shortcut import and the #60 `SUPPORTED_UI_LOCALES` import. No additional runtime behavior or translation wording is introduced to resolve it. EN/KO/JA files in the candidate exactly match #59.

With the validation correction, the combined candidate passed 87/87 locale/audit/Hub-boundary tests and 34/34 BYOS tests (121 distinct tests across eight files). Sequential Chrome MV3 and Firefox MV3 builds passed (16.61 MB each). Both output trees contain ten native locale files, including `zh_CN` and `zh_TW`, and contain no Hub page/assets, removed Hub locale keys or old Hub launch text. The integration audit records exactly 22 removed keys and the four shared replacements, with no unrecorded omissions or placeholder/model-prompt differences. The inert stored Hub schema and historical migrations remain preserved by #59.

All test runs used `SKIP_FREE_API=true`, a 3 GiB Node heap cap, at most two workers and no file parallelism. Memory availability was checked at 47% before validation and 38% before combined builds; other build/test processes were checked and the usage-page browser builds had completed. Existing large-chunk/module-directive and Azerbaijani-native-locale warnings remain. These build results do not establish browser runtime performance or translation quality.

Issue #47's final head and `options.apiUsage.*` copy remain pending for this integration. No provisional usage strings were copied or classified as deleted keys. Once its head is fixed, record its new English keys as deliberate fallbacks and rerun only the relevant integration checks. No remote CI, PR merge, Pro review or actual browser input was performed in this follow-up.

The coordinator's Pro review of `fd3d3010` reported no P0–P2 or current runtime defect and one P3 audit false negative. The `2f46bd83` placeholder correction did not catch same-placeholder value edits or missing shared aliases before English adds them. Those cases were reproduced against that audit (seven newly failing assertions), then addressed by the offline snapshot and required-key checks above. This follow-up changes audit code, fixtures and inventory/documentation only; no locale wording or product runtime is changed.
