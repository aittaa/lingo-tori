# LingoTori

LingoTori is an independent browser extension for bilingual page and subtitle translation, dictionary meanings and sentence explanations. Its interface supports English, Korean and Japanese; translation language support remains broader.

Configure your provider and API key in **API Providers**, then explicitly assign the provider to each feature. New installs start without a provider. Gemini and Azure BYOK remain supported alongside other configured model APIs. Dictionary and original reading suggestions remain; Study navigation and the newly added vocabulary/SRS, learning web and backend have been removed. Future learning work is backlog scope.

## ChatGPT subscription integration

**Sign in with ChatGPT** is an experimental Chromium browser-only flow inside API Providers. There is no companion, server address or pairing key. A direct sign-in action requests the optional callback permission before opening authorization; no permission or account access is requested automatically. BYOK remains independent.

This source implementation is not live-verified or established as officially supported/store-approved. Current official guidance specifies protected runtime storage outside browsers and a loopback listener; this experimental design instead uses an extension-origin local database and a narrowly scoped navigation redirect. Read [BYOS status and boundaries](docs/byos.md) before enabling it. Firefox authentication is unavailable; its BYOK translation remains supported.

## Development

Use the Node and pnpm versions in `package.json`. For initial setup, install with `pnpm install --ignore-scripts`, then run `pnpm exec wxt prepare`. Use `pnpm build` or `pnpm build:firefox` for loadable builds. Basic validation needs no service, account credentials or inference call.

```sh
SKIP_FREE_API=true pnpm test
pnpm type-check
pnpm build
pnpm build:firefox
```

Hosted accounts, billing, telemetry, cloud transcription, speech playback, writing assistance, input translation and executable custom layouts are excluded. Provider requests use the endpoint you configure; review it before use.

## Attribution and license

This project is a fork of [Read Frog](https://github.com/mengxi-ream/read-frog), originally authored by its upstream contributors. The original [GNU GPL license](LICENSE) and upstream authorship remain intact. Independent rendering and language contracts replace the removed `@read-frog` packages without copying their implementations.
