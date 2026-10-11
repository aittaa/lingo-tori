# Core validation and merge gate

This snapshot contains the independent BYOK core. Account authentication, companion services, callback routing and their experimental verification evidence are excluded.

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
