# LingoTori

LingoTori is an independent browser extension for bilingual page and subtitle translation, dictionary meanings and sentence explanations. Its interface supports English, Korean and Japanese; translation language support remains broader.

Configure your provider and API key in **API Providers**, then explicitly assign the provider to each feature. New installs start without a provider. Gemini and Azure BYOK remain supported alongside other configured model APIs. Dictionary and original reading suggestions remain; Study navigation and the newly added vocabulary/SRS, learning web and backend have been removed. Future learning work is backlog scope.

Existing experimental provider records and their feature IDs remain as inert compatibility data. They are not selectable and cannot run requests in this core build. Choose a BYOK provider explicitly for any affected feature; there is no automatic paid fallback and no stored database deletion.

## Development

Use the Node and pnpm versions in `package.json`. For initial setup, install with `pnpm install --ignore-scripts`, then run `pnpm exec wxt prepare`. Use `pnpm build` or `pnpm build:firefox` for loadable builds. The merge gate needs no service, account credentials or inference call. Run tests only immediately before merging a PR, not during implementation or PR preparation. CI automation is reviewed separately.

```sh
SKIP_FREE_API=true pnpm test
pnpm type-check
pnpm build
pnpm build:firefox
```

Hosted accounts, billing, telemetry, cloud transcription, speech playback, writing assistance, input translation and executable custom layouts are excluded. Provider requests use the endpoint you configure; review it before use.

## Attribution and license

This project is a fork of [Read Frog](https://github.com/mengxi-ream/read-frog), originally authored by its upstream contributors. The original [GNU GPL license](LICENSE) and upstream authorship remain intact. Independent rendering and language contracts replace the removed `@read-frog` packages without copying their implementations.
