# AGENTS.md

## Testing Notes

- Run tests only immediately before merging a PR. Do not run tests during implementation, commits, pushes, or PR creation; prepare the relevant checks for the merge gate instead.
- The former live free-API provider suite was removed with the retired translation providers.
- When running tests locally as an AI agent, set `SKIP_FREE_API=true`.
- Keep local validation independent of live external translation services; set `SKIP_FREE_API=true` for any compatible optional live-service checks.

## PR Notes

- Keep each PR focused on one coherent, reviewable change. Separate completed and validated work from unfinished or experimental work; use explicit dependent PRs when necessary.
- Do not expand an existing PR to absorb unrelated follow-up work or let a blocked feature hold up completed work.
- PR titles must use conventional commit format, such as `fix(subtitles): ...`; avoid extra prefixes like `[codex]`.
- User-facing fixes and features should include a `.changeset/*.md` file for `@lingotori/extension` unless the change intentionally does not need a release. use conventional commit format for the changeset content.
- Obtain explicit user confirmation immediately before merging.
