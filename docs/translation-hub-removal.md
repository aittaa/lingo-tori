# Translation Hub removal

Issues [#43](https://github.com/aittaa/lingo-tori/issues/43) and [#48](https://github.com/aittaa/lingo-tori/issues/48) describe the same feature: the `translation-hub` extension page is launched as Translation Hub and titled Multi-API Text Translation (`멀티 API 텍스트 번역`). Its cards run requests for multiple selected providers. One removal PR covers the shared screen and execution path; separate PRs would delete the same files or leave a partially reachable feature.

The removal deletes the HTML entrypoint, page components and atoms, per-provider card orchestration, popup button, sidebar link, content-script launch shortcut, shortcut settings row and settings search entry. Feature-only locale keys are removed from English, Korean and Japanese. Language search and selected-text error wording remain under shared namespaces. No feature-only asset or package dependency was found; the translation executor, prompt configuration, provider registry, language controls, caching and transport have retained callers.

Page and selected-text translation, existing video captions, dictionary meanings, sentence explanations, reading suggestions, multiple BYOK configurations, feature assignments and BYOS remain. This change does not alter video auto-activation, UI-locale availability, usage pages or general architecture.

## Saved data

`config.translationHub` remains an inert compatibility field with its existing schema and defaults. Removing it from the Zod schema would strip saved values on later settings reads/writes/exports. Its shortcut, selected provider IDs, languages and prompt ID are therefore preserved, including empty selections and IDs whose providers no longer exist. No runtime binds its shortcut or executes its providers. Historical migrations and fixtures remain; the config version does not change. Provider keys, BYOS authentication storage, glossary data and other user records are untouched. A future purge would need separate owner approval and a retention plan.

## Verification plan

Regression tests are prepared for persisted config round trips with BYOK/BYOS feature assignments, inert Hub shortcut conflicts, removal of the settings search entry, retained shortcut ordering, popup prompt selection and selected-text failure messages. Run them only at the final merge gate under AGENTS.md, with `SKIP_FREE_API=true` and no more than two workers. Include the retained provider, translation, subtitle, dictionary and BYOS suites at that gate.

Prepare WXT types and record type-aware lint, formatting, changeset status and sequential Chromium/Firefox builds separately from tests. Inspect each build for absence of `translation-hub.html`, Hub launch strings and multi-provider card assets. Confirm retained popup/options/sidepanel/content-script outputs and the Chromium-only BYOS callback. Builds and static inspection do not prove browser or live-provider behavior. Browser verification and CI are not authorized for this task; they remain NOT RUN. Obtain explicit owner confirmation immediately before any merge.
