# EN/KO/JA cleanup audit

This focused documentation and locale branch starts at the exact core PR #14 snapshot `ff1fdb47635c49391ffce6d3fa5e7d6f5c43b49b`. The baseline worktree is `/private/tmp/lingotori-en-ko-ja-baseline-20261011`; the candidate is `/private/tmp/lingotori-en-ko-ja-docs-20261011`. Neither the primary checkout nor the active BYOS branch is an input to this comparison.

## Scope and preservation

Removed 60 obsolete assets containing 27,867,419 tracked blob bytes: 55 repository marketing assets (26,943,165 bytes) and five orphaned source assets (924,254 bytes). The old store images included Chinese-facing examples and promises of input translation, speech, hosted AI and Notebase. Current EN/KO/JA examples and the independently drawn context-menu SVG replace that stale material.

`LICENSE`, `public/LICENSE`, `public/NOTICE.txt`, `package.json`, `pnpm-lock.yaml` and `wxt.config.ts` are unchanged from the base. Japanese dictionary examples, language labels including Chinese, algorithms, multilingual fixtures and historical migrations remain. Historical changelog entries remain provenance records.

The locale files remove retired-feature and marketing labels, update subtitle wording and supply the nine keys requested by the [subtitle worker in draft PR #17](https://github.com/aittaa/lingo-tori/pull/17): `subtitles.actions.{copySource,copyTranslated,copyPreparing,copyTranslating,copyReady,copyComplete,copyRetry,copyFailed,copyUnavailable}`. The handoff is based on subtitle commit `6d09a5c3627c07745b6ad23248805be3db3a1d3a`. These keys do not implement clipboard behavior; the subtitle worker owns implementation. Clipboard runtime behavior is not verified here.

Two `form.layout` label keys and `action.customActionLayoutFallback` remain as compatibility text for existing consumers and describe plain text results. `noteSuggestion.save` remains for a test asserting the button is absent; it does not add a save control. The core worker should remove the obsolete `CUSTOM_ACTION_LAYOUT_SECTION_ID` search entry from `src/entrypoints/options/command-palette/search-items.ts`; this branch does not edit shared navigation implementation.

## Reproduce static checks

Run from the candidate repository root with installed dependencies:

```sh
node scripts/audit-ui-resources.mjs --base ff1fdb47635c49391ffce6d3fa5e7d6f5c43b49b
git diff --check
git diff ff1fdb47635c49391ffce6d3fa5e7d6f5c43b49b -- package.json pnpm-lock.yaml wxt.config.ts LICENSE public/LICENSE public/NOTICE.txt
```

The audit uses the existing Vite YAML plugin's parser. It checks YAML validity, new locale fallback gaps, placeholder changes, literal source references to deleted keys and local documentation-link destinations. It reports inherited gaps separately. It does not validate remote HTTP status or prove dynamically assembled keys are covered.

Korean and Japanese retain the same 13 English-fallback keys as the base. No new fallback gaps are intended. The audit lists them explicitly instead of silently asserting complete key parity.

Deleted blob bytes can be repeated with Python built-ins and local Git:

```sh
python3 - <<'PY'
import subprocess
base = 'ff1fdb47635c49391ffce6d3fa5e7d6f5c43b49b'
files = subprocess.check_output(['git', 'diff', base, '--name-only', '--diff-filter=D'], text=True).splitlines()
sizes = [int(subprocess.check_output(['git', 'cat-file', '-s', base + ':' + file])) for file in files]
print(len(files), sum(sizes))
PY
```

## Build and artifact provenance

Both worktrees use the same locally installed dependencies, copied into isolated worktrees with `cp -cR`. No install scripts, credentials, live translation requests or service setup were used. Measurement runs use Node 25.5.0, WXT 0.21.4, Vite 8.3.4 and zlib 1.2.12. This differs from the manifest's Node 26.11.1 and pnpm 12.10.1 declarations; repeat the merge gate on the declared toolchain. The available pnpm is 11.19.0 and was not used for the builds.

Run each build sequentially in each worktree:

```sh
SKIP_FREE_API=true RAYON_NUM_THREADS=2 UV_THREADPOOL_SIZE=2 node node_modules/wxt/bin/wxt.mjs build
SKIP_FREE_API=true RAYON_NUM_THREADS=2 UV_THREADPOOL_SIZE=2 node node_modules/wxt/bin/wxt.mjs build -b firefox --mv3
```

WXT builds its entrypoint groups sequentially. Worker environment limits are set to two; formatting and lint also use `--threads=2`. Both builds retain existing warnings about large chunks and module directives. Single recorded build timings are preparation evidence, not browser runtime measurements.

Use the existing read-only measurement script after builds finish, substituting the appropriate root:

```sh
node scripts/measure-footprint.mjs \
  --repo /private/tmp/lingotori-en-ko-ja-baseline-20261011 \
  --output /private/tmp/lingotori-en-ko-ja-baseline-20261011/.output/chrome-mv3 \
  --output /private/tmp/lingotori-en-ko-ja-baseline-20261011/.output/firefox-mv3
```

Direct dependencies remain 82 runtime and 39 development entries. The unchanged lockfile contains two YAML documents with 15 and 1,366 package entries, respectively, totaling 1,381 distinct package keys and 1,381 resolved-snapshot keys. These are lockfile inventories, not a verified count of reachable transitive dependencies. Installation and dependency-graph resolution were not rerun.

Source package SHA-256: `572b30c9dea02f5469d5b4d753f12c10aefe8c102ba067993c872bb9c0a578bc`. Lockfile SHA-256: `14cf1920e95dc663a71c7d10943abd9113b8b0418da898fb9555429f56840387`.

Artifact measurements and final static-check results are recorded alongside this document after the focused source commit. Historical [baseline.json](baseline.json) and [after.json](after.json) describe other revisions and do not validate this branch.

## Remaining merge gate

Regression tests are **NOT RUN**, following `AGENTS.md`: run them only immediately before merging, with `SKIP_FREE_API=true` and bounded workers. Installed-browser locale/clipboard verification and live-provider verification are **NOT RUN**. The SVG illustration was rendered and visually inspected, but is not an installed-extension demo.

The baseline type-aware lint reports two existing errors: BYOS provider typing in `src/types/config/provider/constants.ts:235` and a translation-queue fixture in `src/entrypoints/background/__tests__/translation-queues.test.ts:1158`. This focused branch leaves those core-owned files unchanged. Review the final check comparison before merging. Obtain explicit user confirmation immediately before any merge; this draft task does not merge or enable auto-merge.
