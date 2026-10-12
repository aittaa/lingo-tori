# Validation and merge gate

The checkpoints below describe the independent BYOK core at pinned main `628a67e61a46303c54b2250b1a85d461a46d143d`. The new combined BYOS candidate has separate [integration validation](byos-core-integration.md); historical core-only results do not validate that tree. Companion services remain excluded, while reviewed browser-only authentication and callback routing are included in the integration candidate.

## Preparation status

The extracted snapshot is prepared using source reads and static searches only. Tests, type checks, formatting checks and builds are NOT RUN for this extraction. Earlier mixed-scope checkpoints do not validate the extracted tree.

## Planned merge gate

Run these checks only immediately before merging the focused core PR, with the repository dependencies and the versions declared in package.json:

| Check                       | Command or condition                                                                                        | Current result |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------- |
| Regression tests            | `SKIP_FREE_API=true pnpm test`                                                                              | NOT RUN        |
| Type-aware lint             | `SKIP_FREE_API=true pnpm type-check`                                                                        | NOT RUN        |
| Formatting                  | `pnpm fmt:check`                                                                                            | NOT RUN        |
| Chromium build              | `pnpm build`                                                                                                | NOT RUN        |
| Firefox build               | `pnpm build:firefox`                                                                                        | NOT RUN        |
| Fresh settings              | API Providers opens before configuring a provider                                                           | NOT RUN        |
| Configuration compatibility | BYOK keys, language and glossary choices survive migration; experimental rows and selected IDs remain inert | NOT RUN        |
| Runtime boundaries          | No account authentication, companion listener, callback entrypoint or automatic paid fallback               | NOT RUN        |

Use synthetic fixtures and mocks. No live account credentials or inference calls are needed. CI automation, publication and deployment are reviewed separately.
