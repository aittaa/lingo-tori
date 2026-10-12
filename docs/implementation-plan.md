# Implementation plan

Baseline: `ca8da8241883c9aff5862d15d045845a746c9a6b`. Follow `AGENTS.md`, conventional commits and extension changesets.

## Completed core scope

1. Retain independent page, selection and subtitle translation, dictionary explanations, BYOK configuration and original reading suggestions.
2. Preserve independently authored language/result contracts, safe React rendering, GPL licensing and upstream attribution.
3. Remove commercial hosted accounts, billing, telemetry, speech, input translation, executable result layouts, new vocabulary/SRS/Study/web/backend work, and companion runtimes.
4. Preserve language, glossary, BYOK configuration and user records through migration v111. Preserve saved BYOS ON/OFF, model and assignments without resetting unrelated settings or choosing a paid fallback; actual execution requires authenticated account access.
5. Keep API Providers usable on a fresh install before any provider is configured.

## Review and merge gate

The core and reviewed BYOS changes remain individually traceable. This integration candidate combines their pinned inputs, preserving main cleanup and captured-provider routing. CI policy and settings remain owner-controlled. Version remains 1.50.3 until release planning is reviewed.

Do not run tests during implementation, commits, pushes or PR creation. Immediately before merging, run the relevant regression suite with `SKIP_FREE_API=true`, type/lint and formatting checks, Chrome/Firefox builds, and applicable installed-browser checks. Report PASS, FAIL and NOT RUN accurately. Basic validation must not depend on live translation services or account credentials.

## Deferred scope

New learning/backend development remains future backlog. No new account/provider framework or reasoning-control redesign is included in this integration. Experimental browser-only BYOS retains its explicit support and live-verification limits.
