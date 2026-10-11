# LingoTori project documentation

LingoTori is being developed as an independent GPLv3 fork of Read Frog focused on dependable reading, translation, dictionary explanations and user-configured providers.

## Status

The baseline is `ca8da8241883c9aff5862d15d045845a746c9a6b`. The active priority is a lean translation/BYOK foundation and optional experimental BYOS. Useful existing vocabulary/learning pieces are retained; further learning development, including backend, is deferred. The review stack remains #9 → #10 (deferred draft) → #11 → #12. Nothing has been merged or released. See [validation and remaining gates](validation.md) for observed checks and limitations.

- [Product requirements](product-requirements.md): retained features, exclusions, and user experience.
- [Architecture and licensing](architecture-and-licensing.md): dependency findings, independent implementation boundaries, and data ownership.
- [Implementation plan](implementation-plan.md): reviewable phases, acceptance criteria, and release gates.
- [Retained learning prototype](learning.md): existing behavior and limits; additional learning/backend work is deferred.
- [BYOS companion specification](byos.md): official companion and hosting boundaries.

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
| Official local BYOS integration           | [#8](https://github.com/aittaa/lingo-tori/issues/8) |

[Footprint baseline and reproducible measurement](metrics/README.md) records the clean upstream build evidence. GitHub Actions was verified disabled on this fork before issue/PR creation on 2026-10-11; it must remain disabled until separately reviewed.
