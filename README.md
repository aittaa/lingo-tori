# LingoTori

An independent GPLv3 browser extension for page, selected-text and existing video-caption translation, dictionary meanings and sentence explanations. The interface offers **Azerbaijani, English, Spanish, Japanese, Korean, Russian, Turkish, Vietnamese, Simplified Chinese and Traditional Chinese**, with [documented English fallbacks](docs/ui-locale-restoration.md) for changed or missing copy. Translation languages remain broader, including Chinese.

The standalone Translation Hub / Multi-API Text Translation screen has been removed. Multiple provider configurations and per-feature assignments remain supported. Previously saved Hub preferences are retained as inactive compatibility data; see the [removal scope and validation plan](docs/translation-hub-removal.md).

## Use your own provider

Open **API Providers** and choose **Sign in with ChatGPT** ([experimental browser-only sign-in](docs/byos-firefox.md)), or add an API key for a provider or compatible endpoint. Gemini and Azure are supported alongside other model APIs. New installs have no provider. Requests use your own account or key and can incur charges or usage limits. Registering an API provider only saves its configuration; it does not validate the key. API-key providers remain independent of ChatGPT sign-in, and no automatic paid fallback runs.

When an enabled provider is added to an empty provider list, it fills only the empty feature slots it is compatible with. Existing choices and each feature's ON/OFF state are unchanged. For ChatGPT, this also requires a connection and an available model. Later providers do not fill slots, and you can still configure each feature manually.

Original reading suggestions remain. Voice playback, writing/input assistance, hosted accounts and backup, cloud transcription, vocabulary/SRS and companion services are outside this core. Subtitles require captions supplied by the video platform; supported platform adapters currently cover YouTube, X and Netflix. Site behavior can change, and this draft core still requires the [merge validation gate](docs/validation.md).

There is one translation target language; there is no separate native-language setting. Smart context and automatic video translation are both OFF by default. With automatic video translation ON in the popup or settings, subtitles start only when the caption source language is known and differs from the translation target language. Same or unknown languages are not started automatically. Turning subtitles OFF in the player applies to the current video, and the next video follows the setting again. Turning the global setting OFF cancels pending starts but does not stop sessions already running.

ChatGPT sign-in is experimental and available in Chromium and Firefox 140+. Requests need authenticated account access. Native QA on Firefox ESR 140.17.0 covered sign-in, model discovery, Korean subtitles and recovery after an extension background restart, but it ran on an earlier candidate ([PR #65](https://github.com/aittaa/lingo-tori/pull/65)), not current main. Full browser restart, long-term token refresh and clean-profile API-key runtime verification remain pending ([#8](https://github.com/aittaa/lingo-tori/issues/8) / [#36](https://github.com/aittaa/lingo-tori/issues/36)), as does comprehensive QA of current main; see the [Firefox notes](docs/byos-firefox.md). This does not establish official ChatGPT support, store approval or signed distribution.

## Development

Use the Node and pnpm versions declared in [package.json](package.json).

```sh
pnpm install --ignore-scripts
pnpm exec wxt prepare
pnpm dev
```

Build Chromium with `pnpm build` or Firefox MV3 with `pnpm build:firefox`. Load `.output/chrome-mv3` through Chromium's extension developer tools. In Firefox, load the manifest from `.output/firefox-mv3` as a temporary add-on through `about:debugging`. Follow [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md); run tests only immediately before merging, with `SKIP_FREE_API=true`, and obtain explicit user confirmation immediately before the merge.

The independent version baseline is **0.0.1**, without a prerelease suffix. See the [version and installation notes](docs/versioning.md) for package names, build receipts, and replacing an earlier temporary `1.50.3` installation without deleting its data.

[Project documentation](docs/index.md) includes scope, limitations, licensing and [measured footprint evidence](docs/metrics/README.md). Builds and static checks do not establish live-provider or browser-runtime performance.

## Attribution and license

Forked from [Read Frog](https://github.com/mengxi-ream/read-frog). Preserve upstream authorship and the [GNU GPLv3 license](LICENSE); see [NOTICE.txt](public/NOTICE.txt). Independent rendering and language contracts replace removed `@read-frog` integrations.
