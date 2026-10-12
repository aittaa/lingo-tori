# LingoTori

An independent GPLv3 browser extension for page, selected-text and existing video-caption translation, dictionary meanings and sentence explanations. The interface offers **Azerbaijani, English, Spanish, Japanese, Korean, Russian, Turkish, Vietnamese, Simplified Chinese and Traditional Chinese**, with [documented English fallbacks](docs/ui-locale-restoration.md) for changed or missing copy. Translation languages remain broader, including Chinese.

The standalone Translation Hub / Multi-API Text Translation screen has been removed. Multiple provider configurations and per-feature assignments remain supported. Previously saved Hub preferences are retained as inactive compatibility data; see the [removal scope and validation plan](docs/translation-hub-removal.md).

## Use your own provider

The core uses **BYOK** (bring your own API key). Open **API Providers**, add a provider or compatible endpoint, then explicitly assign it to each feature. Gemini and Azure are supported alongside other model APIs. New installs have no provider, and requests can incur your provider's charges. See the [BYOK setup guide](docs/byok.md).

Original reading suggestions remain. Voice playback, writing/input assistance, hosted accounts and backup, cloud transcription, vocabulary/SRS and companion services are outside this core. Subtitles require captions supplied by the video platform; supported platform adapters currently cover YouTube, X and Netflix. Site behavior can change, and this draft core still requires the [merge validation gate](docs/validation.md).

[Experimental browser-only BYOS](docs/experimental-byos.md) adds **Sign in with ChatGPT** inside API Providers for Chromium. Existing ON/OFF, model and feature assignments are preserved; actual requests require authenticated account access. BYOK remains independent, and no automatic paid fallback runs. This integrated source candidate requires its own validation and review; earlier live evidence does not verify the combined build.

## Development

Use the Node and pnpm versions declared in [package.json](package.json).

```sh
pnpm install --ignore-scripts
pnpm exec wxt prepare
pnpm dev
```

Build Chromium with `pnpm build` or Firefox MV3 with `pnpm build:firefox`. Load `.output/chrome-mv3` through Chromium's extension developer tools. In Firefox, load the manifest from `.output/firefox-mv3` as a temporary add-on through `about:debugging`. Follow [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md); run tests only immediately before merging, with `SKIP_FREE_API=true`, and obtain explicit user confirmation immediately before the merge.

[Project documentation](docs/index.md) includes scope, limitations, licensing and [measured footprint evidence](docs/metrics/README.md). Builds and static checks do not establish live-provider or browser-runtime performance.

## Attribution and license

Forked from [Read Frog](https://github.com/mengxi-ream/read-frog). Preserve upstream authorship and the [GNU GPLv3 license](LICENSE); see [NOTICE.txt](public/NOTICE.txt). Independent rendering and language contracts replace removed `@read-frog` integrations.
