# Architecture and licensing

## Audit scope and evidence

The baseline audit examined extension-owned integration code at `ca8da8241883c9aff5862d15d045845a746c9a6b`. Restricted package implementations were not inspected, copied, or reverse-engineered. This document describes findings and proposed changes; it does not certify completed removal or legal clearance.

Preserve the existing GPLv3 license and upstream attribution. Fork identity, branding, and runtime service ownership change; legal attribution remains. Package implementation reuse requires a clear compatible license and provenance.

## Dependency removal boundaries

| Dependency                       | Baseline coupling                                                                                        | Required approach                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `@read-frog/layout-engine@0.4.0` | Result rendering, editor extensions, presets, default config, action templates, previews, speech adapter | Remove integration and write a simple independent React result display; do not reproduce the engine or its templates             |
| `@read-frog/definitions@0.8.0`   | Language schemas/data, labels, app identity, auth constants, bridge protocols, service metadata          | Independently define retained local contracts; use documented appropriately licensed language data; delete obsolete integrations |
| `@read-frog/api-contract@0.19.0` | Hosted AI schemas/errors, output field schema, Notebase types, quota and SRS calls                       | Remove hosted clients; define first-party result and learning DTOs from requirements rather than copying package implementations |

The layout package is identified as proprietary. The other two packages have unresolved license metadata in the audit context; absence of metadata is not permission to vendor their implementations.

### Embedded preset provenance

`src/utils/config/migration-scripts/v102-to-v103.ts:63–64` explicitly identifies frozen copies of `DEFAULT_LAYOUT`, `LAYOUT_SPEAK_BUTTON_CSS`, and `SPEAK_BUTTON_ICONS` from layout-engine presets. The audit identified the provenance comment without examining the copied implementation. Package removal alone therefore cannot establish a clean result. Related migration tests and render fixtures also need a provenance inventory without treating those snapshots as implementation references.

Resolve this through removal or an independently authored migration/import strategy, with the exception to historical frozen-migration policy documented and tested. Do not copy the snapshots into a new renderer, a replacement package, or documentation. The upstream migration skill normally requires immutable self-contained migration snapshots and a continuous registry; changes needed to remove restricted content must preserve the chain and user data through an explicit tested approach.

### Historical compatibility exception implemented

The v102-to-v103 step now uses an independently authored compatibility transform that removes legacy layout and speech fields while preserving unrelated settings. Its previous preset-producing implementation and generated render fixtures were removed without using them as implementation references.

Historical example fixtures v103-v110 were scrubbed by parsing TypeScript and replacing only `layout` and `sampleData` value ranges; removed payloads were not displayed or retained. Eight fixture files contained 22 affected properties. The chain suite compares all other historical settings exactly and separately asserts that retired payloads remain inert. This is an explicit provenance exception to frozen historical snapshots, not permission to rewrite unrelated migrations. The new v111 migration and fixture remain independently owned by the learning implementation.

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

## Learning architecture

The baseline is not a local SRS implementation. `use-save-to-notebase.ts` calls upstream authentication and `notebaseRow.create/createMany`; `background/notebase-pending-save.ts` coordinates service-dependent saves. `selection-toolbar/review-due-tab.tsx` fetches upstream SRS counts and opens its website. `src/utils/db/dexie/app-db.ts` contains caches and glossary tables, not cards or review history.

Proposed components:

- A background-owned local repository stores vocabulary notes, cards, scheduler state, append-only review events, and a synchronization outbox.
- Content scripts submit narrowly validated save/review requests through extension messaging. They do not receive backend credentials or own database writes.
- A pure, deterministic, versioned scheduler supports offline reviews. Implement independently or choose a separately reviewed appropriately licensed scheduler; do not infer or reproduce upstream server behavior.
- The independent backend accepts versioned first-party DTOs and idempotency keys. The learning web application shares the specified scheduling behavior and data semantics.
- Synchronization uses stable identifiers, replay-safe operations, tombstones, and an explicit conflict policy. A server must not silently overwrite unsynced local study history. Resolve concurrent review events deterministically and test that resolution.
- Local persistence succeeds before network work begins. A durable outbox survives service-worker restarts. Account changes isolate remote state and retain/export unsynced local data.

Keep translation glossaries separate from vocabulary cards. BYOK credentials remain extension configuration and are excluded from learning payloads and exports intended for learning synchronization.

## Service and permission boundary

Remove original authentication clients, oRPC service clients, payment/quota UI, telemetry, backup/auth integrations, and upstream guide/ebook bridges unless replaced by a specifically required independent feature. `background/proxy-fetch.ts` mixes generic fetch and auth-cookie cache invalidation; separate retained functionality before removal. Remove unused cookie and other permissions only after reviewing every remaining consumer.

The original ebook bridge in `selection.content/external-selection-source.ts` is restricted to upstream origins. If the independent learning web needs a bridge, specify a new versioned, origin-checked protocol with narrow capabilities. Do not expose arbitrary fetch, keys, or privileged extension actions to page messages.

The open-source local companion is described in [BYOS](byos.md). Keep its configuration and process boundary explicit. Local companion development is separate from approval to deploy hosted infrastructure or use paid/live APIs.

## Migration and build risks

- Config schema failures can cause fallback-to-default behavior and overwrite synchronized settings. Explicitly test older configs containing removed providers, layouts, TTS, writing, and service connections.
- `AppDB` derives its database name from `APP_NAME`; rebranding can open a different empty database. Use a stable identifier or explicit migration/import.
- `src/utils/config/default-translate-provider.ts` probes Google during fresh setup. Remove this automatic network path, not just provider UI.
- `src/utils/providers/provider-availability.ts` assumes hosted providers are appended. Empty-provider handling must become an honest setup state.
- Preserve Gemini/Azure BYOK independently from removing Google/Microsoft translation services.
- Build/source archives, lockfiles, aliases, fixtures, and generated artifacts require a final restricted-dependency/provenance check.

Keep upstream automation disabled until replacement CI is intentionally reviewed. Remote repository controls are coordinated by the owner; documentation alone cannot enforce them.
