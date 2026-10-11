# Implementation plan

## Baseline and status policy

Baseline: `ca8da8241883c9aff5862d15d045845a746c9a6b`. The acceptance criteria below remain the target; the initial implementation is in draft and does not satisfy every release gate. See [validation](validation.md) for observed results. No merge, release, deployment or live account exercise has occurred.

Use small conventional-commit draft PRs and English issues. Follow `AGENTS.md` changeset requirements for user-facing changes. Preserve GPLv3 and attribution. No merge, deployment, live paid API exercise, or token-dependent testing is authorized by this plan.

## Initial implementation scope

- Phases 0–3 and 5 have initial code and offline regression coverage, pending installed-extension verification.
- Phase 4 provides versioned full-state manual synchronization, deterministic `simple-v1` review-event replay, a loopback-only single-namespace personal server, and an independent learning web. Local persisted state is retained on failed synchronization. A separate outbox, deletion/tombstone protocol, hosted accounts, multi-account UI and offline web PWA are deferred; the corresponding acceptance criteria are not claimed complete.
- The local BYOS companion and extension adapter use the documented official protocol with mock-only tests. Actual account eligibility, sign-in/token rotation, model listing and generation remain unverified. No live tokens were created.
- Phase 6 has local type, lint, unit and build validation; installed-browser smoke tests and a faithful extension demo remain open. Original automated workflows are removed from the candidate and remote Actions remain disabled.

## Phase 0: Establish safe fork operation

Deliver the requirements, architecture, implementation plan, and separate BYOS specification. Keep upstream workflow automation disabled; the owner coordinates remote settings before branch activity could trigger it. Review workflow files and release/publish hooks before introducing replacement CI.

Acceptance:

- Documentation distinguishes audited baseline, proposed work, and observed results.
- Remote automation status is verified separately; no document claims that merely editing workflow YAML disabled repository automation.
- Local validation uses the dedicated launcher and `SKIP_FREE_API=true`.
- No secrets are committed, copied into documentation, or required for the basic test suite.

## Phase 1: Remove proprietary layout integration

Replace the result view with independently authored React field cards. Remove layout editing/previews, engine presets, speech adapter, integration helpers, alternate aliases, and package dependency. Inventory the frozen preset copies and related fixtures without using them as implementation references. Resolve their distribution/removal strategy in this phase.

Acceptance:

- Dictionary and custom-action fields render during and after streaming.
- Text, numeric zero, absent values, malformed output, and errors have explicit behavior.
- Model output and legacy template strings never execute HTML, scripts, Liquid, or speech behavior.
- No layout-engine runtime import, alias, package entry, or restricted preset snapshot remains in deliverable source/build artifacts.
- Legacy config handling preserves unrelated settings and the migration chain.

## Phase 2: Own retained contracts and BYOK-only translation

Create local language and output contracts from independent requirements and licensed data. Retain page translation, selected-text explanation, dictionary and sentence analysis. Remove hosted AI routes, quotas, tiers and contracts; Google/Microsoft translation providers and installation probes; and stale capability assumptions. Preserve Gemini/Azure BYOK.

Acceptance:

- Fresh install and startup make no upstream or removed-provider request.
- With no usable provider, the UI requests configuration; it never silently chooses a paid endpoint.
- Existing valid BYOK IDs, keys, model choices and custom endpoints survive migration.
- BYOK page translation and structured explanation pass mocked success, partial-stream, cancellation and failure tests.
- Language selectors, detection, labels, RTL and target-language behavior remain multilingual.
- No imports or aliases remain to `@read-frog/definitions` or `@read-frog/api-contract` once dependent service paths are removed.

## Phase 3: Local vocabulary and offline SRS

Introduce background-owned notes/cards/review events, a deterministic versioned scheduler, local study UI and export/import. Replace Notebase save controls with local saving. Replace server-derived due counts with local counts. Preserve glossary data independently.

Acceptance:

- Dictionary results save without authentication and while offline.
- Duplicate save requests are idempotent; failed writes are visible and do not report success.
- Saved notes and review history survive worker restarts and extension updates.
- Offline review updates due state deterministically for each rating, using a controlled clock in tests.
- Timezone/day-boundary rules are explicit and tested; due counts and review queue agree.
- Export/import round-trips user-authored data and identifies its schema/scheduler versions.
- Rebranding does not strand the previous local database.

## Phase 4: Independent backend, learning web and BYOS

Implement the first-party synchronization contract and independent learning web with the same scheduler semantics. Add the open-source local companion route described in [BYOS](byos.md). Use local/mocked environments until hosted operation receives separate approval.

Acceptance:

- Note/card/review synchronization retries safely after interruption and duplicate delivery.
- Outbox records survive restart; deletions and concurrent edits/reviews follow documented conflict rules.
- Account changes isolate server records and retain unsynced local records for recovery.
- Extension and web agree on review state for the same versioned event history.
- BYOK keys never enter learning synchronization payloads.
- Local companion configuration does not require upstream login or expose arbitrary privileged extension actions.
- Hosted deployment remains explicitly unperformed until approved.

## Phase 5: Remove remaining commercial and excluded surfaces

Remove upstream auth/payment/service clients and backup/auth integrations, telemetry, voice/TTS, writing assistance and input translation. Remove routes, shortcuts, context menus, commands, background handlers, storage defaults, service links and unnecessary permissions. Avoid deleting retained generic infrastructure merely because a removed service also used it.

Acceptance:

- No excluded capability remains reachable through UI, keyboard shortcuts, messages or background handlers.
- No automatic upstream service request occurs during install, startup, opening settings, selection, saving, review or sync initialization.
- No telemetry or hosted backup request occurs.
- Permissions correspond to remaining features; no orphaned cookie/auth listener remains.
- EN/KO/JA interfaces are coherent and engine language support is unchanged by UI localization.

## Phase 6: Release readiness, without automatic release

Audit package manifests, lockfile, source aliases, generated bundles, distribution archives, fixture provenance and legal notices. Record local Chrome/Firefox build results and test evidence. Introduce only reviewed replacement CI with a safe local/mocked default and no publish/deploy side effects.

Acceptance:

- No `@read-frog/*` dependency/runtime path or restricted implementation is distributed.
- GPLv3 license and upstream attribution remain intact; independent additions and third-party data have recorded provenance.
- Type checking, relevant unit tests, migration tests and browser builds pass, with intentional live-service skips reported honestly.
- Manual local smoke checks cover page translation, selection dictionary, offline save/review and settings migration.
- Draft PR evidence identifies remaining limitations. Passing checks does not merge, deploy, publish or create a release.

## Targeted validation

Use `/Users/hyeonkim-server/workspace/lingo-tori-local/pnpm` from the repository. Retain `SKIP_FREE_API=true` for safe local test commands. The candidate removes the old live free-translation suite with its Google/Microsoft Translate adapters. Do not install dependencies or invoke token-dependent services as a substitute for missing local prerequisites.

Preserve and adapt meaningful tests around:

- `src/components/custom-action/__tests__/use-custom-action-execution.test.ts`
- `src/entrypoints/background/__tests__/background-stream.test.ts`
- `src/types/config/__tests__/selection-toolbar.test.ts`
- `src/utils/config/__tests__/migration.test.ts` and migration-chain tests
- Provider reference/availability, selection toolbar/shortcuts and language-direction/page-language tests

Add focused tests for the independent renderer, offline save/review, replay-safe sync, account boundaries, legacy config preservation and prohibited network destinations. Inspect generated bundles in addition to source searches; stale aliases and transitive packages can escape a UI-only review.

## Open decisions

The initial scheduler is independently authored `simple-v1`; the shared state schema is version 1. The learning web uses the loopback server origin, and the companion requires explicit extension-origin pairing and permits one active inference operation. JSON import preserves existing note and review IDs. Remaining decisions include a future hosted identity/deployment model, deletion semantics, multiple senses per term, multi-account BYOS, and access to upstream-only notes. No local audit establishes access to notes held only on upstream servers. Resolve these without copying proprietary or unresolved-license implementations.
