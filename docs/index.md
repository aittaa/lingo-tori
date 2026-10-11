# LingoTori project documentation

LingoTori is being developed as an independent GPLv3 fork of Read Frog focused on dependable reading, translation, dictionary explanations and user-configured providers.

## Status

The baseline is `ca8da8241883c9aff5862d15d045845a746c9a6b`. Current work focuses on translation, dictionary explanations and BYOK. New non-upstream learning/SRS/web/backend and the companion implementation are removed. Original reading suggestions and necessary independent contracts remain. Browser-only ChatGPT sign-in is experimental source with explicit official-support and live-verification limits. Completed settings, independent-core and CI work are reviewed separately; #12 retains the experimental follow-up. #10 and #11 are superseded without merge. See [validation](validation.md) for the per-PR merge gate.

- [Product requirements](product-requirements.md): retained features, exclusions, and user experience.
- [Architecture and licensing](architecture-and-licensing.md): dependency findings, independent implementation boundaries, and data ownership.
- [Implementation plan](implementation-plan.md): reviewable phases, acceptance criteria, and release gates.
- [Browser-only BYOS status](byos.md): experimental architecture, official-support differences and security/validation gates.

## Operating rules

Preserve the repository's GPLv3 license and upstream copyright attribution. Do not copy or reverse-engineer proprietary package implementations or vendor implementations from packages with unresolved license metadata.

Keep original upstream workflow automation disabled while preparing the fork. A local test pass does not authorize remote CI, deployment, publishing, or a release. The repository owner coordinates remote workflow settings separately.

Development may produce English issues, pushed branches, and draft pull requests. Merging, deployment, paid live API calls, and token-dependent integration exercises are outside the current authorization. Use mocks and local validation with `SKIP_FREE_API=true`.

## Tracking

Parent: [Independent LingoTori product (#2)](https://github.com/aittaa/lingo-tori/issues/2).

| Work                                      | Issue                                               |
| ----------------------------------------- | --------------------------------------------------- |
| Planning, license boundaries and baseline | [#3](https://github.com/aittaa/lingo-tori/issues/3) |
| Independent layout and language contracts | [#4](https://github.com/aittaa/lingo-tori/issues/4) |
| Hosted service and provider cleanup       | [#5](https://github.com/aittaa/lingo-tori/issues/5) |
| Voice, writing, branding and locales      | [#6](https://github.com/aittaa/lingo-tori/issues/6) |
| Deferred learning/backend future work     | [#7](https://github.com/aittaa/lingo-tori/issues/7) |
| Experimental browser-only BYOS            | [#8](https://github.com/aittaa/lingo-tori/issues/8) |

[Footprint baseline and reproducible measurement](metrics/README.md) records the clean upstream build evidence. GitHub Actions was verified disabled on this fork before issue/PR creation on 2026-10-11; it must remain disabled until separately reviewed.
