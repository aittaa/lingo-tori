# Initial independent implementation validation

This is local draft evidence, not a release-readiness claim. Product source commit: `d1d083bd56ad137407102beceb113a2a4bf6aa15`; baseline: `ca8da8241883c9aff5862d15d045845a746c9a6b`. Subsequent changes in this PR record documentation and measurements only.

## Review stack

1. [Planning #9](https://github.com/aittaa/lingo-tori/pull/9), based on `main`.
2. [Local learning and independent language catalog #10](https://github.com/aittaa/lingo-tori/pull/10), based on the planning branch; source commit `22cddd68`.
3. [Local BYOS companion #11](https://github.com/aittaa/lingo-tori/pull/11), based on the learning branch; source commit `94a28907`.
4. Extension integration on `feat/independent-lingotori`, based on the companion branch. This intentionally keeps tightly coupled removal, migration, providers and UI changes together. It adds the release changeset for the initial fork; no version or tag is released.

All are draft. Issues #2–#8 remain open until acceptance and review, and nothing is merged. Remote GitHub Actions was explicitly disabled and rechecked before pushes; inherited release/bot workflows are removed from the candidate. Re-enabling automation needs a separate review.

## Reproduce locally

On the prepared server Mac, enter the repository and source the sibling `lingo-tori-local/env.sh`. It selects Node 26.11.1, pnpm 12.10.1, the dedicated dependency store, `SKIP_FREE_API=true`, and disabled Nx cloud/daemon behavior. Existing reviewed install/setup hooks prepare WXT types and Git hooks; no new dependencies were introduced. Unused packages were removed with offline, script-disabled lockfile updates. The wrapper's later dependency synchronization ran already-reviewed setup hooks.

```sh
pnpm type-check
pnpm fmt:check
SKIP_FREE_API=true pnpm test --maxWorkers=4 --reporter=dot
node --test apps/companion/test/*.test.mjs packages/learning-core/core.node-test.mjs apps/learning-server/*.node-test.mjs
pnpm build
pnpm zip:firefox
pnpm exec changeset status
```

No upstream environment variables or build-time credentials are required. Final candidate builds do not use the baseline's `WXT_SKIP_ENV_VALIDATION` bypass. The old live free-translation tests were deleted with their retired adapters; current tests use mocks and self-closing local HTTP fixtures.

## Observed results

| Check                                                                     | Status  | Evidence                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type and lint                                                             | PASS    | `pnpm type-check` runs the project's type-aware/type-checking Oxlint command.                                                                                                                                              |
| Formatting and diff whitespace                                            | PASS    | Repository formatter and `git diff --check`.                                                                                                                                                                               |
| Complete Vitest suite                                                     | PASS    | 332 files, 3,319 tests; one recorded run 50.41 seconds.                                                                                                                                                                    |
| Companion + learning Node suites                                          | PASS    | 45 tests: 32 companion and 13 learning/core/server/web.                                                                                                                                                                    |
| Isolated PR exports                                                       | PASS    | Committed learning files pass 13 Node tests; committed companion files pass 32.                                                                                                                                            |
| Chrome MV3                                                                | PASS    | `.output/chrome-mv3/`; no environment-validation bypass.                                                                                                                                                                   |
| Firefox MV3 and archives                                                  | PASS    | `.output/firefox-mv3/`, `.output/lingotoriextension-1.50.3-firefox.zip`, `.output/lingotoriextension-1.50.3-sources.zip`.                                                                                                  |
| Changeset package mapping                                                 | PASS    | Minor entry resolves to `@lingotori/extension`; no release run.                                                                                                                                                            |
| GPL preservation                                                          | PASS    | Root `LICENSE` unchanged; SHA-256 `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`. Identical license and attribution notice included in build outputs.                                                  |
| Runtime/package inventory                                                 | PASS    | No `@read-frog/*` manifest, lockfile or runtime import remains; generated runtime scans found no selected upstream service domains. Locale artifacts are en/ko/ja. Cookies, identity and offscreen permissions are absent. |
| Installed-extension visual demo and native IndexedDB lifecycle            | NOT RUN | Current tooling cannot faithfully install/control the built extension; separate preview-server launch was declined by automatic approval review. Unit/mocked persistence tests do not replace this gate.                   |
| Live BYOS sign-in, token issuance/rotation, eligible models and inference | NOT RUN | No real account credentials or paid API calls used.                                                                                                                                                                        |
| Hosted operation, deployment, merge or release                            | NOT RUN | Outside this task's authorization.                                                                                                                                                                                         |

The smaller test count relative to the 4,078-test baseline reflects removed feature suites and added independent regressions; it does not claim a coverage improvement. The comparison script records exact file bytes and dependency counts in [metrics/after.json](metrics/after.json). Build/test timings are single samples, not browser CPU or memory measurements.

Detailed local logs are preserved in the sibling `lingo-tori-local/logs/`: `final-type-lint.log`, `final-format-check.log`, `final-vitest.log`, `final-node.log`, `pr-learning-node.log`, `pr-byos-node.log`, `final-build-chrome.log` and `final-build-firefox.log`. Final archive hashes and checks are in the local sidecar `final-artifacts.json`.

## Review findings resolved

Separate reviewers rechecked dictionary instruction/body limits, persisted BYOS model selection, cancellation after same-document navigation, sender isolation, source-language propagation, language-alias identity, imported review preservation, due-clock refresh, and retrying the original failed review. Companion tests use mocked upstream responses, including the full structured dictionary prompt. Existing duplicate note IDs are preserved rather than destructively merged.

## Remaining boundaries

- BYOS is experimental local OSS integration with official protocol documentation, not verified account interoperability. Hosted/commercial deployment requires the applicable approval. The first version supports one persisted registration and one active inference; local bearer credentials have restrictive file permissions, not OS encryption.
- Learning uses manual full-state synchronization and a deterministic independently authored `simple-v1` scheduler. Separate outbox, delete/tombstones, hosted account authentication, multi-account UI, multiple senses per term and offline web PWA are deferred. No claim is made about access to upstream-only notes.
- EN/KO/JA UI, README and examples replace Chinese-facing product copy; Chinese translation support, Japanese Han text, legal/provenance names and meaningful historical/multilingual fixtures remain. Compatibility DOM/CSS/storage identifiers may still contain `read-frog`; these are not package or hosted-service dependencies.
- Eleven specifically identified Chinese marketing assets were removed. Broader deletion of unreferenced non-Chinese marketing images was declined by automatic approval review because non-use and embedded attribution were not sufficiently established. They remain in Git, excluded from the source ZIP; obsolete runtime demo PNGs are unreferenced and do not enter built extension output.
- All repository commands and worker tools were verified on the same server Mac and repository filesystem. Requested model allocation was Astra orchestration/review and Sol implementation after the handoff; the tools do not attest active runtime model identity.
- Commits/pushes use `HUSKY=0` after explicit checks to avoid lint-staged stashing shared concurrent work and duplicate Nx hooks. Validation evidence is recorded above; hook bypass is not represented as hook success.
