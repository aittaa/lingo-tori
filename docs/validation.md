# Validation and merge gate

## Current state and scoped evidence — 2026-10-12 UTC

Main `d1bba610634c7000dd930743f39948274e743271` includes experimental browser-only BYOS ([PR58](https://github.com/aittaa/lingo-tori/pull/58), merge `462a5a50d6812ce5ae91204d94a04a914528b101`), subtitle plain-text copying ([PR17](https://github.com/aittaa/lingo-tori/pull/17)) and Translation Hub / multi-API text translation removal ([PR59](https://github.com/aittaa/lingo-tori/pull/59)). Companion services remain excluded. Browser-only BYOS is not established as officially supported; see its [architecture and limitations](byos.md).

- **Offline CI:** manual [run 38200156435](https://github.com/aittaa/lingo-tori/actions/runs/38200156435) passed on 2026-10-12 for candidate `5bfbd85c6dfc10717eaef6d05a9ccd7f015ddcbe`, using workflow policy `18b7995339225eb5a008190ededd81400a89818e`. A clean hosted Ubuntu 24.04 install with Node 26.11.1 and pnpm 12.10.1 passed preparation, formatting, type-aware lint/type checks, 347 test files / 3,546 tests with `SKIP_FREE_API=true`, and sequential Chrome and Firefox MV3 builds. These results apply to that candidate, not all later commits or the current main tree. The run did not explicitly cap Vitest workers; [issue #37](https://github.com/aittaa/lingo-tori/issues/37) retains that operational exception.
- **Real Chrome observation:** the [2026-10-11 BYOS status](byos.md) and [stream acceptance record](byos-missing-content-type.md) report the saved GPT-6.1-Sol model rendering Korean subtitles from an English video after subtitles ON, followed by Pause and subtitles OFF. This is limited initial-flow evidence from a local candidate, not acceptance of the current main tree or every account/model/lifecycle. The stream record pins its failing PR32 baseline to `3a5adddd9a2738264bbc95f3baafae973b814bf0`; it does not identify a passing candidate SHA. Pending cancellation and explicit retry remained unverified in that observation.
- **Firefox BYOS:** compatibility work is separate and real Firefox account sign-in remains unverified. A passing Firefox build does not establish browser/account interoperability.

For future code changes, run the relevant offline merge gate on the exact proposed tree immediately before merging, using the declared toolchain and `SKIP_FREE_API=true`. Check server memory, cap test workers at two and avoid overlapping expensive builds. A docs-only reconciliation does not require another full test/build run. CI execution, publication and deployment require separate authorization.

## Historical core-only preparation — 2026-10-12 UTC

The following record belongs to the independent BYOK core at pinned main `628a67e61a46303c54b2250b1a85d461a46d143d`, before the later combined BYOS integration. It records extraction preparation using source reads and static searches only; its NOT RUN results and inert-account/no-callback expectations are historical, not the current runtime boundary. The later candidate's preparation is recorded in [integration validation](byos-core-integration.md).

The planned gate for that extraction used the repository dependencies and versions declared in package.json:

| Check                       | Command or condition                                                                                        | Historical result |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------- |
| Regression tests            | `SKIP_FREE_API=true pnpm test`                                                                              | NOT RUN           |
| Type-aware lint             | `SKIP_FREE_API=true pnpm type-check`                                                                        | NOT RUN           |
| Formatting                  | `pnpm fmt:check`                                                                                            | NOT RUN           |
| Chromium build              | `pnpm build`                                                                                                | NOT RUN           |
| Firefox build               | `pnpm build:firefox`                                                                                        | NOT RUN           |
| Fresh settings              | API Providers opens before configuring a provider                                                           | NOT RUN           |
| Configuration compatibility | BYOK keys, language and glossary choices survive migration; experimental rows and selected IDs remain inert | NOT RUN           |
| Runtime boundaries          | No account authentication, companion listener, callback entrypoint or automatic paid fallback               | NOT RUN           |

Use synthetic fixtures and mocks. No live account credentials or inference calls are needed. CI automation, publication and deployment are reviewed separately.
