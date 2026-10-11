# Product requirements

## Current product goal

Keep a lean, dependable independent translator: usable page/selection/subtitle translation, dictionary meanings and sentence explanations, BYOK onboarding/settings, clear failures and cancellation, and honest installed-extension evidence. Preserve multilingual translation and EN/KO/JA UI. Avoid feature expansion.

## Retained scope

- User-configured BYOK providers and compatible custom endpoints, including Gemini and Azure.
- Dictionary/custom-action rendering, copy controls and original reading-suggestion generation, validation, term/meaning display and enable toggle.
- Independently authored rendering and language contracts required to replace `@read-frog` dependencies.
- Original translation glossary/cache behavior and stable storage identifiers.

## Removed scope and future work

Compare learning provenance against original upstream `ca8da8241883c9aff5862d15d045845a746c9a6b`. Remove newly introduced vocabulary storage, SRS, Study UI, standalone learning web/server and their learning-only tests/handlers. Remove unavailable local-save/review controls without restoring the previously removed commercial Notebase service. Do not infer that every use of the word “learning” is new code; original language-proficiency settings and dictionary explanations remain.

Study navigation is removed. Future learning/backend development is backlog issue #7, not active product implementation. Source removal does not authorize deleting user databases, exported vocabulary or browser profile data.

The companion, server setup, pairing UI and browser-only account integration are excluded from this BYOK core snapshot. Persisted experimental provider rows and selected IDs remain inert so unrelated settings are preserved. They are not selectable or executable, and they never fall back automatically to a paid provider.

## Excluded commercial integrations

Remove original hosted login, payments, quotas, AI services, commercial links, telemetry and cloud backup. Remove Google Translate and Microsoft Translate adapters while keeping independent Gemini/Azure BYOK. Voice/TTS, input translation, writing assistance, executable result layouts and all `@read-frog` package imports/aliases remain excluded. Preserve GPL and upstream attribution.

## Minimum acceptance

1. A fresh install without a provider opens usable settings and clearly requests configuration.
2. BYOK can be configured and explicitly assigned; page translation and selected-text explanations have clear errors/cancellation.
3. API Providers exposes BYOK configuration and explicit feature assignment, without account authentication, companion setup or automatic paid fallback.
4. Study/new learning/companion entrypoints and active setup paths are absent. Original reading suggestions, dictionary explanations and translation contracts remain.
5. Relevant regression, type/lint, Chrome/Firefox build and available installed-browser checks report PASS/FAIL/NOT RUN precisely. Source inspection and mocks do not replace live verification.

Preserve valid provider settings, custom endpoints, language choices, glossary data and user records. Config failures must not overwrite data with defaults. No merge, release, deployment, live inference or credential creation follows from passing tests.
