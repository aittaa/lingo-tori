# Footprint measurements

[EN/KO/JA cleanup audit](en-ko-ja-cleanup.md) records the focused branch based on exact core snapshot `ff1fdb47635c49391ffce6d3fa5e7d6f5c43b49b`. The historical measurements below belong to different revisions and do not validate that core snapshot or its cleanup branch.

`baseline.json` records the baseline product revision `ca8da8241883c9aff5862d15d045845a746c9a6b`. Its Chrome and Firefox artifacts come from successful builds of that clean baseline. Commands and recorded results appear below; build logs are not source dependencies.

Historical source and dependency counts were established by the initial read-only audit at clean `ca8da824` and match the saved baseline measurement. Existing artifact provenance is established separately by the setup evidence. Package and lockfile SHA-256 hashes were checked against that evidence. Later measurement and comparison runs may occur during concurrent source edits: their current Git state and source counts do not prove that existing outputs were rebuilt from that worktree. Later planning or product changes do not change the recorded baseline build revision.

## Repeat a measurement

Use explicit absolute paths to trusted, quiescent directories. The tool requires the Git repository root and output directories inside it. Directory paths accept trailing separators and normalize consistently before root and duplicate-output checks. It rejects symlink path components, including symlinked output roots. On macOS, use `/private/tmp` rather than the `/tmp` symlink for test fixtures.

```sh
node scripts/measure-footprint.mjs \
  --repo /absolute/path/to/lingo-tori \
  --output /absolute/path/to/lingo-tori/.output/chrome-mv3 \
  --output /absolute/path/to/lingo-tori/.output/firefox-mv3 \
  --baseline /absolute/path/to/lingo-tori/docs/metrics/baseline.json \
  > /private/tmp/lingo-tori-footprint.json
```

Omit `--baseline` to produce a standalone measurement. The tool writes JSON only to stdout, uses Node built-ins and local Git, and never builds, installs, starts services, or accesses the network. Git calls use `--no-optional-locks` so status inspection does not refresh the index on disk. It hashes only `package.json` and `pnpm-lock.yaml`; it does not inspect dependency package implementations. Output traversal uses `lstat`, skips symlinks and special files, and excludes common credential paths, environment files, and nested `node_modules`/`.git` trees before reading their contents. These exclusions are defense in depth, not a substitute for selecting trusted build-output directories. Do not run concurrently with a build modifying those directories.

Results contain no timestamp or absolute repository path. The same files, Git state and Node/zlib version produce identical JSON. Two baseline measurements were byte-identical. Temporary isolated fixtures verified nested byte and gzip totals, symlink loops and symlink-root rejection, sensitive-file exclusions, outside-repository rejection, and baseline deltas. No fixture files were added to the product tree.

## Definitions

- Dependencies are manifest key counts: runtime, development, optional and peer are reported separately. `runtimeAndDevelopment` adds the first two; it does not count transitive packages or deduplicate names across sections.
- Source counts use `git ls-files`: untracked new files are excluded until added to the index. `trackedFiles` includes documentation; `trackedSrcFiles` includes all tracked `src/` paths. Source code is `.ts`, `.tsx`, `.js` or `.jsx`; tests contain `.test.` in their source path; locale paths begin `src/locales/`. Tracked deleted files remain in this index-based inventory until staged. Review Git state before comparing.
- Output bytes are exact regular-file lengths, grouped by extension. The ten largest files are listed with deterministic path tie-breaking. Skipped symlinks, special files and sensitive paths are explicit.
- Gzip bytes sum independent level-9 gzip streams for every included file, including images. This is a reproducible compression proxy, **not** a ZIP archive size or browser download estimate. Match recorded Node/zlib versions for strict comparisons.
- Baseline comparison reports numeric differences in dependencies, source and outputs. It intentionally excludes largest-file arrays, Git state, provenance and hashes. Check hashes and toolchain separately. Missing numeric fields have a null delta. A zero numeric delta does not prove identical contents.

## Verified baseline evidence

The preparation record reports Node 26.11.1 and pnpm 12.10.1 for the project. Measurement runtime versions are recorded independently in `measurement.toolchain`.

| Validation            | Command                                                                                                    | Recorded result                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Chrome build          | `WXT_SKIP_ENV_VALIDATION=true pnpm build`                                                                  | PASS; reported finish 6.611 s                    |
| Firefox build and ZIP | `WXT_SKIP_ENV_VALIDATION=true pnpm zip:firefox`                                                            | PASS; reported finish 8.022 s; ZIP stage 1.681 s |
| Type and lint checks  | `pnpm type-check`                                                                                          | PASS                                             |
| Formatting            | `pnpm fmt:check`                                                                                           | PASS                                             |
| Tests                 | `WXT_SKIP_ENV_VALIDATION=true SKIP_FREE_API=true pnpm test --exclude='**/free-api.test.ts' --maxWorkers=4` | 381 files, 4,078 tests passed; 97.63 s           |

These checks predate the measurement tool. Free API tests were intentionally excluded under `AGENTS.md`. Browser/runtime smoke tests, production credential validation and the monorepo-dependent dev-local test were not performed. Environment validation was bypassed for the recorded builds; these results are not production credential validation.

The baseline contains 93 runtime and 41 development dependencies, 1,531 tracked source files, 1,485 source code files, 375 source test files and ten locales. The test runner's 381-file total includes suites outside the source-only inventory.

| Existing artifact     | Files |      Bytes |
| --------------------- | ----: | ---------: |
| Chrome MV3 directory  |   197 | 23,811,511 |
| Firefox MV3 directory |   197 | 23,811,806 |
| Firefox ZIP           |     — |  7,884,929 |
| Sources ZIP           |     — |  3,055,910 |

Archive bytes and hashes are copied from verified preparation evidence, not regenerated or unpacked by the tool. Tool-reported build summary sizes may differ from the exact on-disk inventory; use the same inventory definition on both sides of a comparison.

All timings are single recorded samples. Smaller output, fewer dependencies, and shorter one-off build times do not demonstrate lower browser CPU, memory use or faster runtime behavior. A runtime claim needs a separate controlled browser experiment with the same page, effective configuration, hardware, browser and repeated runs.

## Initial independent candidate

[after.json](after.json) records source commit `d1d083bd56ad137407102beceb113a2a4bf6aa15` with documentation-only working changes. Both final output directories include the unchanged GPL text and attribution notice. Final packaging also includes reviewed repository documentation in the source ZIP.

| Metric                          |   Baseline |  Candidate |  Change |
| ------------------------------- | ---------: | ---------: | ------: |
| Direct runtime dependencies     |         93 |         82 |     -11 |
| Direct development dependencies |         41 |         39 |      -2 |
| Total direct dependencies       |        134 |        121 |     -13 |
| Tracked src files               |      1,531 |      1,359 |    -172 |
| UI locales                      |         10 |          3 |      -7 |
| Chrome output files             |        197 |        170 |     -27 |
| Chrome output bytes             | 23,811,511 | 14,612,631 | -38.63% |
| Firefox output bytes            | 23,811,806 | 14,612,889 | -38.63% |

These byte counts include license/notice files and use the same filesystem inventory definition as the baseline. Baseline measurement used Node 25.5.0; candidate measurement uses Node 26.11.1, so gzip totals have differing toolchain provenance. Exact uncompressed file bytes and manifest key counts are the primary comparison. No browser speed/memory claim is made. See [validation](../validation.md) for tests, artifacts and remaining live/browser gates.
