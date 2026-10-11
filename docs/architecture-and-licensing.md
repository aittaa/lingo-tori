# Architecture and licensing

## Audit scope and evidence

The baseline audit examined extension-owned integration code at `ca8da8241883c9aff5862d15d045845a746c9a6b`. Restricted package implementations were not inspected, copied, or reverse-engineered. This document describes findings and the intended final scope; implementation details belong to the separate core and experimental PRs. It does not certify that their code is present in this planning PR or establish legal clearance.

Preserve the existing GPLv3 license and upstream attribution. Fork identity, branding, and runtime service ownership change; legal attribution remains. Package implementation reuse requires a clear compatible license and provenance.

## Dependency removal boundaries

| Dependency                       | Baseline coupling                                                                                        | Required approach                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `@read-frog/layout-engine@0.4.0` | Result rendering, editor extensions, presets, default config, action templates, previews, speech adapter | Remove integration and write a simple independent React result display; do not reproduce the engine or its templates             |
| `@read-frog/definitions@0.8.0`   | Language schemas/data, labels, app identity, auth constants, bridge protocols, service metadata          | Independently define retained local contracts; use documented appropriately licensed language data; delete obsolete integrations |
| `@read-frog/api-contract@0.19.0` | Hosted AI schemas/errors, output field schema, Notebase types, quota and SRS calls                       | Remove hosted clients; define retained first-party result DTOs from requirements rather than copying package implementations     |

The layout package is identified as proprietary. The other two packages have unresolved license metadata in the audit context; absence of metadata is not permission to vendor their implementations.

### Embedded preset provenance

`src/utils/config/migration-scripts/v102-to-v103.ts:63–64` explicitly identifies frozen copies of `DEFAULT_LAYOUT`, `LAYOUT_SPEAK_BUTTON_CSS`, and `SPEAK_BUTTON_ICONS` from layout-engine presets. The audit identified the provenance comment without examining the copied implementation. Package removal alone therefore cannot establish a clean result. Related migration tests and render fixtures also need a provenance inventory without treating those snapshots as implementation references.

Resolve this through removal or an independently authored migration/import strategy, with the exception to historical frozen-migration policy documented and tested. Do not copy the snapshots into a new renderer, a replacement package, or documentation. The upstream migration skill normally requires immutable self-contained migration snapshots and a continuous registry; changes needed to remove restricted content must preserve the chain and user data through an explicit tested approach.

### Planned historical compatibility exception

The separate independent-core change proposes an independently authored v102-to-v103 compatibility transform to remove legacy layout and speech fields while preserving unrelated settings. That code and its generated-fixture cleanup are not included in this planning PR.

The core PR must validate the v103-v110 fixture cleanup, preserve all unrelated historical settings and assert that retired payloads stay inert. The compatibility exception does not permit rewriting unrelated migrations. Review v111 and its fixture with the corresponding service retirements.

### Precise integration paths

- `src/components/layout-host/custom-action-layout-view.tsx` mounts the engine. `fallback-field-list.tsx` also imports its formatter, so the fallback is not independent yet.
- `src/utils/layout-host/*`, `src/utils/constants/config.ts`, and `custom-action-templates.ts` import presets or engine contracts.
- `src/components/ui/liquid-code-editor*` and `src/entrypoints/options/pages/custom-actions/action-config-form/` contain editor, preview, field-reference, and prompt-helper coupling.
- `src/types/config/selection-toolbar.ts` imports a hosted output field schema at runtime. A type-only cleanup is insufficient.
- `wxt.config.ts` aliases all three packages to optional monorepo source directories. Remove alternate resolution along with package and lockfile entries.

## Retained execution path

`src/components/custom-action/use-custom-action-execution.ts` prepares selection/context prompts and invokes the background structured-object stream. `src/entrypoints/background/background-stream.ts` contains both hosted and local generation paths. Preserve independently usable GPL BYOK execution, validation, cancellation, and streaming behavior while removing hosted branches, tiers, quotas, contract schemas, and service errors.

The new result display accepts a local schema and a result/status object. Render escaped React text nodes with explicit handling of strings, numbers, missing values, and partial output. Do not interpret returned HTML, Liquid templates, or speech markup.

Language types, labels, ISO mappings, and directionality are foundational to retained translation. Introduce a local language module from independently documented requirements and appropriately licensed data. Keep UI locale independent of engine languages. Do not reconstruct missing-license tables from their implementation.

## Learning provenance and removal

The upstream baseline did not implement local vocabulary/SRS or a standalone learning server. The newly added `apps/learning-server`, `packages/learning-core`, extension Study entrypoint, learning persistence/messages and background handler are removed. Local-save/review controls introduced to replace commercial Notebase are detached; restoring that hosted dependency is not an acceptable fallback.

Original reading-suggestion generation, validation, term/meaning display and enable controls remain alongside dictionary and sentence explanations. The independently sourced `src/lib/languages` catalog is required by translation even though it was introduced in the same commit as learning. Original language-proficiency settings and translation glossaries are not new SRS code. Preserve the legacy glossary/cache database identifier and do not delete user records.

Future learning/backend work is backlog only. No active learning service or setup guide is retained.

## Service and permission boundary

Remove original authentication clients, oRPC service clients, payment/quota UI, telemetry, backup/auth integrations, and upstream guide/ebook bridges unless replaced by a specifically required independent feature. `background/proxy-fetch.ts` mixes generic fetch and auth-cookie cache invalidation; separate retained functionality before removal. Remove unused cookie and other permissions only after reviewing every remaining consumer.

The original upstream ebook bridge remains removed. Do not expose arbitrary fetch, keys, or privileged extension actions to page messages.

The companion is removed. The replacement browser-only source is experimental; see [BYOS](byos.md) for its dedicated extension-origin vault, optional narrow callback permission and explicit official-support mismatch. Authentication evidence belongs to the separate experimental implementation, not this planning PR.

## Migration and build risks

- Config schema failures can cause fallback-to-default behavior and overwrite synchronized settings. Explicitly test older configs containing removed providers, layouts, TTS, writing, and service connections.
- `AppDB` derives its database name from `APP_NAME`; rebranding can open a different empty database. Use a stable identifier or explicit migration/import.
- `src/utils/config/default-translate-provider.ts` probes Google during fresh setup. Remove this automatic network path, not just provider UI.
- `src/utils/providers/provider-availability.ts` assumes hosted providers are appended. Empty-provider handling must become an honest setup state.
- Preserve Gemini/Azure BYOK independently from removing Google/Microsoft translation services.
- Build/source archives, lockfiles, aliases, fixtures, and generated artifacts require a final restricted-dependency/provenance check.

Keep upstream automation disabled until replacement CI is intentionally reviewed. Remote repository controls are coordinated by the owner; documentation alone cannot enforce them.
