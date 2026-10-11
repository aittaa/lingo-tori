# LingoTori project documentation

LingoTori is being developed as an independent GPLv3 fork of Read Frog focused on dependable reading, translation, dictionary explanations and user-configured providers.

## Status

The baseline is `ca8da8241883c9aff5862d15d045845a746c9a6b`. This core snapshot includes translation, dictionary explanations and BYOK. New non-upstream learning/SRS/web/backend and companion/account runtimes are excluded. Original reading suggestions and necessary independent contracts remain. Existing experimental provider records are retained as inert compatibility data. See [validation](validation.md) for the planned merge gate.

- [Product requirements](product-requirements.md): retained features, exclusions, and user experience.
- [Architecture and licensing](architecture-and-licensing.md): dependency findings, independent implementation boundaries, and data ownership.
- [Implementation plan](implementation-plan.md): reviewable phases, acceptance criteria, and release gates.

## Operating rules

Preserve the repository's GPLv3 license and upstream copyright attribution. Do not copy or reverse-engineer proprietary package implementations or vendor implementations from packages with unresolved license metadata.

CI workflow changes are excluded from this core snapshot and reviewed separately. The repository owner coordinates remote workflow settings, deployment, publishing and release actions.

Keep PRs focused and run tests only immediately before merging, with `SKIP_FREE_API=true`. Provider authentication and live inference are separate user actions; static preparation does not perform them.

## Tracking

Parent: [Independent LingoTori product (#2)](https://github.com/aittaa/lingo-tori/issues/2).

| Work                                      | Issue                                               |
| ----------------------------------------- | --------------------------------------------------- |
| Planning, license boundaries and baseline | [#3](https://github.com/aittaa/lingo-tori/issues/3) |
| Independent layout and language contracts | [#4](https://github.com/aittaa/lingo-tori/issues/4) |
| Hosted service and provider cleanup       | [#5](https://github.com/aittaa/lingo-tori/issues/5) |
| Voice, writing, branding and locales      | [#6](https://github.com/aittaa/lingo-tori/issues/6) |
| Deferred learning/backend future work     | [#7](https://github.com/aittaa/lingo-tori/issues/7) |

[Footprint baseline and reproducible measurement](metrics/README.md) records the clean upstream build evidence. CI enablement belongs to a separate review.
