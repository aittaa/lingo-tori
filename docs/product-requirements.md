# Product requirements

## Product goal and status

Build an independent reading and learning extension with a separate learning web application and a first-party learning backend. The approved direction is recorded here; implementation remains pending unless a merged change and its validation explicitly demonstrate otherwise.

## Required capabilities

1. Translate websites using user-configured providers. Preserve reading context, page translation controls, language handling, and useful translation configuration.
2. Support bring-your-own-key (BYOK) model providers and custom compatible endpoints. Retain Gemini and Azure BYOK: removing Google Translate and Microsoft Translate does not remove those model adapters.
3. Explain selected words and passages through dictionary and sentence-analysis actions. Preserve selected text, nearby context, source URL, and user-selected explanation language.
4. Save vocabulary locally without a service account or network connection. Keep user-authored notes durable, exportable, and recoverable.
5. Support offline spaced-repetition study, with cards, scheduling state, and review history owned by LingoTori. Synchronize through the independent backend when configured, and support a separate learning web application.
6. Offer English, Korean, and Japanese product UI. The translation and learning engine remains multilingual; UI locale must not restrict source or target languages.

## Excluded capabilities and integrations

Remove Read Frog login, payments, quotas, hosted AI services, commercial service links, telemetry, and hosted backup/auth integrations. Remove Google Translate and Microsoft Translate providers, their default selections, probes, and execution branches. Remove voice, TTS, speech controls, input translation, and writing assistance. Remove every `@read-frog/*` package dependency and runtime integration, including alternate monorepo aliases.

Custom result-layout editing is not required for the first independent version. Use a simple independently authored result display. Legacy templates must never be evaluated merely to maintain compatibility.

## User journeys

### First run and translation

A new installation opens local setup and makes no automatic request to upstream services or removed providers. The user configures BYOK explicitly. With no usable provider, show a clear setup state. A configured provider can translate a page or selected text without a Read Frog account.

### Dictionary and saving

Selecting a word or passage opens an explanation using the chosen BYOK provider. Partial results remain readable during streaming. Saving creates a local vocabulary note with the selected term, explanation, context, source, and language. Saving does not depend on authentication or synchronization success.

### Offline study and synchronization

A user can review locally saved cards offline and see the next due time. Review events persist across extension worker restarts. Connecting the independent backend synchronizes notes and review history without exposing BYOK API keys. The learning web application uses the same documented scheduling rules and conflict policy.

### BYOS companion

Provide an open-source local companion route with explicit local connection configuration. See [BYOS](byos.md) for its separately maintained specification. Preparing the companion locally does not authorize launching a hosted service, exposing local services publicly, or deploying infrastructure. Hosted operation requires a separately reviewed deployment decision.

## Data and compatibility requirements

Preserve valid BYOK settings, custom endpoints, language choices, and user-authored glossary data during migration. Removed-provider assignments must resolve to a usable explicitly configured provider or a setup-required state, never a silently substituted paid service.

Do not treat existing glossary substitutions as a vocabulary/SRS database. Maintain distinct models for translation substitutions and learning records. Legacy Read Frog server-held notes are not available locally by assumption; import requires a supported user-provided export or a separately authorized migration route.

Provide an explicit migration path for local database naming. Rebranding must not make existing local records appear lost. Failed config parsing must not overwrite existing settings with defaults.

## Completion criteria

The release must demonstrate offline save and review, BYOK page translation and selected-text explanation, multilingual engine behavior, and EN/KO/JA UI. No removed service should be contacted on install, startup, selection, saving, reviewing, or opening settings. License/provenance, bundle, migration, and permission checks are release gates, not optional cleanup.
