# Implementation plan

Baseline: `ca8da8241883c9aff5862d15d045845a746c9a6b`. This is draft work, not release acceptance. Follow `AGENTS.md`, conventional commits and extension changesets. Use `SKIP_FREE_API=true`; do not require live translation services for validation.

## Active foundation

1. Keep independent page/selection/subtitle translation, dictionary explanations, BYOK configuration and original reading suggestions reliable.
2. Preserve independently authored language/result contracts and safe React rendering while removing upstream commercial/package coupling. Keep GPL and attribution unchanged.
3. Remove newly added vocabulary/SRS, Study, standalone learning web/backend and their unavailable save/review entrypoints. Compare mixed-purpose code against the baseline before removal; preserve original useful features and all user data.
4. Remove companion runtime/setup/pairing. Implement the explicitly requested experimental browser-only source with narrow callback routing, isolated browser storage, strict identity/lifecycle validation and mocks. Disclose the official listener/storage guidance mismatch; fail closed on technical/security failures and never silently fall back to BYOK.
5. Validate the final source and actual production builds; report limited or blocked browser checks honestly.

## Review structure

Keep each PR focused on one coherent change. Merge completed work independently of unfinished or experimental features. The sequence is planning, the empty-provider selector fix, the independent BYOK core, then a separate manual CI merge gate. Browser-only ChatGPT authentication and its unfinished provider editing/inference work remain a separate follow-up. Superseded learning and companion PRs remain closed; preserve ordinary Git history.

The retained language contracts, renderer, service retirements and config migration form one coupled core change. Splitting these by file category would leave invalid intermediate configurations; review their integration together. Preserve original reading suggestions and user data.

## Validation

Use the Node and pnpm versions declared in `package.json`. Prepare relevant checks while implementing, but execute tests only immediately before merging each PR, with `SKIP_FREE_API=true`. At that merge gate, validate the exact candidate scope, type/lint, formatting and Chrome/Firefox builds as appropriate. Record commands, commit IDs, results and any limitations in the PR.

Source tests do not establish live OAuth or inference success. Remote workflow settings, releases and deployments remain separate operations. See [validation guidance](validation.md).

## Future backlog

Learning and backend development are future issue #7 with no current implementation milestone. Browser-only BYOS remains issue #8 with the support/live/browser acceptance limits in [BYOS status](byos.md). Neither future scope nor live readiness is completed by passing mocks. Existing historical validation is in [validation](validation.md), separately from results for the final source.
