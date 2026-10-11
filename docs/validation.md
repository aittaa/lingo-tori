# Validation

Validation applies to the commits and conditions below. Synthetic tests and installed UI checks do not establish successful live authentication or inference.

## Checkpoints

- Original upstream baseline: `ca8da8241883c9aff5862d15d045845a746c9a6b`.
- Learning and companion removal, browser-only experimental BYOS: `1be5d799`, integrated at `0a40c219`.
- Shared ChatGPT provider sign-in flow and initialization recovery: `8054c3b0`.
- ChatGPT provider tile and button alignment: `056c040e`.

The removal preserves original dictionary meanings, sentence explanations, reading-suggestion generation and display, language contracts, and glossary/cache storage. It does not delete existing user databases or browser data.

## Results

The session-review checkpoint before the navigation-error relay passed the complete offline suite: **334 files / 3,372 tests**, using `SKIP_FREE_API=true pnpm test`, plus full type-aware lint/type checking. Focused lifecycle checks cover terminal and transient refresh failures, uncertain rotation, request-level API errors, sanitized stream errors and bounded remote revocation. Routing/UI checks cover worker restart, delayed cleanup and ended login attempts. Independent source review closed the cleanup race and cooldown-recovery findings.

The read-only workflow in `.github/workflows/ci.yml` is prepared and statically validated. CI execution remains **NOT RUN** while repository Actions is disabled. Internal handoff documents and private operational identifiers were removed from the current source; this does not rewrite historical Git commits.

| Check                                                                                                  | Status  | Scope and conditions                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete Vitest suite                                                                                  | PASS    | `SKIP_FREE_API=true pnpm test`: 333 files / 3,325 tests at `0a40c219`. This count does not represent a complete-suite rerun after the provider UI follow-ups.                                                                                                               |
| Preserved reading features                                                                             | PASS    | Focused regression: 6 files / 34 tests covering suggestions, custom-action execution and language data.                                                                                                                                                                     |
| Experimental browser auth                                                                              | PASS    | Focused regression: 8 files / 42 synthetic tests using fake browser/vault APIs, signatures and mocked requests. No real credentials or authentication.                                                                                                                      |
| Shared provider sign-in and recovery                                                                   | PASS    | At `8054c3b0`, 2 files / 35 synthetic tests covering Add provider, direct-click permission requests, duplicate/cancel/late-grant handling, Firefox availability, connected model focus and initialization retry.                                                            |
| Provider/model regression                                                                              | PASS    | 3 files / 10 tests; separate display-name checks passed in 2 files / 16 tests. These focused counts overlap.                                                                                                                                                                |
| Type-aware lint/type check                                                                             | PASS    | `SKIP_FREE_API=true pnpm type-check`.                                                                                                                                                                                                                                       |
| Formatting and whitespace                                                                              | PASS    | `pnpm fmt:check` and `git diff --check`, with scoped formatting after documentation and locale changes.                                                                                                                                                                     |
| Chrome and Firefox MV3 builds and packaging                                                            | PASS    | `pnpm build`, `pnpm build:firefox` and ZIP/source packaging checks. Build success does not validate live sign-in.                                                                                                                                                           |
| Installed Chrome provider UI                                                                           | PASS    | At `8054c3b0`, reloaded an unpacked build and inspected Korean dark-theme API Providers, Add provider and conditional account actions. The later tile alignment at `056c040e` passed 19 existing UI tests and builds; native reload was deferred during the user's sign-in. |
| Earlier live login attempts                                                                            | FAIL    | Earlier attempts hit a refused loopback connection. After the guarded navigation relay, the user completed sign-in and model selection, also observed in Chrome. Video translation remains unsuccessful.                                                                    |
| Installed callback interception, optional permission, real OAuth/restart/account eligibility/inference | NOT RUN | No completed real-browser authentication or inference validation. Mocked request-rule matching does not prove Chromium navigation or initiator behavior.                                                                                                                    |
| Firefox authentication                                                                                 | NOT RUN | The experimental callback implementation is Chromium-only; Firefox BYOK builds remain supported.                                                                                                                                                                            |
| Merge, release, deployment and CI enablement                                                           | NOT RUN | No release or deployment validation.                                                                                                                                                                                                                                        |

## Reproduction conditions

Run checks from the repository root with the prepared dependencies and `SKIP_FREE_API=true`. The Vitest configuration uses a test-only fixed strict port to avoid a startup port probe; it does not start a development server.

For the installed UI check, load the Chrome MV3 build in a signed-out profile, open API Providers, and inspect the account tile and Add provider dialog. A fresh provider-free installation previously produced a null-provider settings crash; the selector fix at `e689f7d6` was verified with focused regressions and an installed settings reload.

For authentication, distinguish opening authorization from completing the callback and obtaining usable account/model access. The later guarded relay enabled user-completed sign-in and model discovery in Chrome. Video translation remains unresolved; its cause must be established separately. See [BYOS limitations](byos.md) before attempting live authentication.

## Historical checks

At `2336097`, the earlier implementation passed 332 Vitest files / 3,319 tests, 45 Node tests and Chrome/Firefox packaging checks. That checkpoint included the subsequently removed learning and companion implementations; its results do not establish readiness of the current browser-only authentication flow.

## Remaining BYOS work

User-completed OAuth and model selection are observed successes. Video translation, unified provider editing and reasoning controls remain unfinished and must not hold up the independent BYOK core. The most recent unrestricted full-suite run was interrupted after a timing failure while sharing resources with live browser work; it is not a passing run. Subsequent targeted relay tests and type checks passed. CI is prepared but has not run.
