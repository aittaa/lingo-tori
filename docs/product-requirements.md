# Product requirements

## Product goal and status

Build a lean, dependable independent translation extension. Prioritize usable page translation, dictionary meanings/explanations, BYOK onboarding/settings, clear failures and cancellation, optional supported BYOS, and installed-extension validation. Avoid new product scope.

Owner priority on 2026-10-11: retain useful existing vocabulary/learning pieces where they do not destabilize or complicate the core. Do not actively expand or polish them. Further learning development, including backend, is deferred future work under issue #7; PR #10 remains an unmerged deferred draft.

## Required capabilities

1. Translate websites using user-configured providers. Preserve reading context, page translation controls, language handling, and useful translation configuration.
2. Support bring-your-own-key (BYOK) model providers and custom compatible endpoints. Retain Gemini and Azure BYOK: removing Google Translate and Microsoft Translate does not remove those model adapters.
3. Explain selected words and passages through dictionary and sentence-analysis actions. Preserve selected text, nearby context, source URL, and user-selected explanation language.
4. Offer English, Korean, and Japanese product UI. Translation remains multilingual; UI locale must not restrict source or target languages.
5. Keep experimental BYOS separate from default BYOK onboarding. Require explicit local pairing and model selection; do not claim live readiness from mock tests.

Existing local vocabulary and review tools may remain, but further work on learning, synchronization and the backend is not part of the current acceptance milestone.

## Excluded capabilities and integrations

Remove Read Frog login, payments, quotas, hosted AI services, commercial service links, telemetry, and hosted backup/auth integrations. Remove Google Translate and Microsoft Translate providers, their default selections, probes, and execution branches. Remove voice, TTS, speech controls, input translation, and writing assistance. Remove every `@read-frog/*` package dependency and runtime integration, including alternate monorepo aliases.

Custom result-layout editing is not required for the first independent version. Use a simple independently authored result display. Legacy templates must never be evaluated merely to maintain compatibility.

## User journeys

### First run and translation

A new installation opens local setup and makes no automatic request to upstream services or removed providers. The user configures BYOK explicitly. With no usable provider, show a clear setup state. A configured provider can translate a page or selected text without a Read Frog account.

### Dictionary explanations and existing saving

Selecting a word or passage opens an explanation using the chosen BYOK provider. Partial results remain readable during streaming. Saving creates a local vocabulary note with the selected term, explanation, context, source, and language. Saving does not depend on authentication or synchronization success.

### Retained learning components — future development deferred

The existing prototype supports local card review and due state. The following describes retained behavior, not a current development milestone. Review events persist across extension worker restarts. Connecting the independent backend synchronizes notes and review history without exposing BYOK API keys. The learning web application uses the same documented scheduling rules and conflict policy.

### BYOS companion

Put a visible Sign in with ChatGPT entry, account/connection status, reconnect and disconnect inside the existing API Providers settings. Keep BYOK configuration usable. Explain and gate the required local companion/pairing setup before the official sign-in action; pairing and mock tests must not imply successful live authentication. See [BYOS](byos.md) for its separately maintained specification. Preparing the companion locally does not authorize launching a hosted service, exposing local services publicly, or deploying infrastructure. Hosted operation requires a separately reviewed deployment decision.

## Data and compatibility requirements

Preserve valid BYOK settings, custom endpoints, language choices, and user-authored glossary data during migration. Removed-provider assignments must resolve to a usable explicitly configured provider or a setup-required state, never a silently substituted paid service.

Do not treat existing glossary substitutions as a vocabulary/SRS database. Maintain distinct models for translation substitutions and learning records. Legacy Read Frog server-held notes are not available locally by assumption; import requires a supported user-provided export or a separately authorized migration route.

Provide an explicit migration path for local database naming. Rebranding must not make existing local records appear lost. Failed config parsing must not overwrite existing settings with defaults.

## Completion criteria

The current foundation milestone must demonstrate fresh-install settings without a provider, explicit provider configuration, BYOK page translation and selected-text explanation, clear errors/cancellation, multilingual engine behavior, and EN/KO/JA UI. Learning/backend expansion and release acceptance are deferred. No removed service should be contacted on install, startup, selection, saving, reviewing, or opening settings. License/provenance, bundle, migration, and permission checks are release gates, not optional cleanup.
