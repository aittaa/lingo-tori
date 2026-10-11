# Implementation plan

Baseline: `ca8da8241883c9aff5862d15d045845a746c9a6b`. This is draft work, not release acceptance. Follow `AGENTS.md`, conventional commits and extension changesets. Use `SKIP_FREE_API=true`; do not require live translation services for validation.

## Active foundation

1. Keep independent page/selection/subtitle translation, dictionary explanations, BYOK configuration and original reading suggestions reliable.
2. Preserve independently authored language/result contracts and safe React rendering while removing upstream commercial/package coupling. Keep GPL and attribution unchanged.
3. Remove newly added vocabulary/SRS, Study, standalone learning web/backend and their unavailable save/review entrypoints. Compare mixed-purpose code against the baseline before removal; preserve original useful features and all user data.
4. Remove companion runtime/setup/pairing. Implement the explicitly requested experimental browser-only source with narrow callback routing, isolated browser storage, strict identity/lifecycle validation and mocks. Disclose the official listener/storage guidance mismatch; fail closed on technical/security failures and never silently fall back to BYOK. No live authentication or installed-browser permission grant.
5. Validate the final source and actual production builds; report limited or blocked browser checks honestly.

## Review structure

The active target stack is planning #9 → integration #12. New-learning #10 and companion #11 are superseded without merge. Their ordinary Git history remains, but their removed runtime code must not appear in the integration's final tree. The independent language catalog introduced alongside learning remains required by translation and is reviewed in #12. Use normal additive commits and ordinary branch integration only; no force push, reset, history purge or duplicate implementation PR.

## Validation

Use the Node and pnpm versions declared in `package.json`. Scope tests to changed behavior, then run type/lint, formatting and Chrome/Firefox builds. Test preserved reading suggestions and dictionary/custom-action execution when removing save integrations. Inspect built entrypoints, package references, permissions and license inclusion. The installed extension should omit Study navigation, retain BYOK setup, and show browser-only ChatGPT configuration without companion fields or automatic sign-in.

Automated checks use synthetic credentials and mocked services. Browser acceptance, CI execution and release acceptance are distinct from source test results. Local test success does not authorize or establish a release.

## Future backlog

Learning and backend development are future issue #7 with no current implementation milestone. Browser-only BYOS remains issue #8 with the support/live/browser acceptance limits in [BYOS status](byos.md). Neither future scope nor live readiness is completed by passing mocks. Existing historical validation is in [validation](validation.md), separately from results for the final source.
