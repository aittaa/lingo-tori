# LingoTori project documentation

LingoTori is being developed as an independent GPLv3 fork of Read Frog focused on dependable reading, translation, dictionary explanations and user-configured providers.

## Status

The baseline is `ca8da8241883c9aff5862d15d045845a746c9a6b`. This candidate combines the independent translation/dictionary/BYOK core with experimental browser-only BYOS. New non-upstream learning/SRS/web/backend, commercial hosted accounts and companion runtimes remain excluded. Original reading suggestions and necessary independent contracts remain. Saved BYOS ON/OFF, model and feature assignments are preserved; execution checks enablement and authenticated access. See [integration preparation](byos-core-integration.md) and [validation](validation.md).

- [BYOK setup](byok.md): configure and explicitly assign your own provider.
- [Experimental BYOS status](experimental-byos.md): current source, activation policy and historical live-evidence boundaries.
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

[Footprint baseline and reproducible measurement](metrics/README.md) records historical artifact provenance. [EN/KO/JA cleanup audit](metrics/en-ko-ja-cleanup.md) records this focused branch's source and build evidence. CI enablement belongs to a separate review.
