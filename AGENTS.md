# AGENTS.md

## Testing Notes

- The former live free-API provider suite was removed with the retired translation providers.
- When running tests locally as an AI agent, set `SKIP_FREE_API=true`.
- Keep local validation independent of live external translation services; set `SKIP_FREE_API=true` for any compatible optional live-service checks.

## PR Notes

- PR titles must use conventional commit format, such as `fix(subtitles): ...`; avoid extra prefixes like `[codex]`.
- User-facing fixes and features should include a `.changeset/*.md` file for `@lingotori/extension` unless the change intentionally does not need a release. use conventional commit format for the changeset content.
