# LingoTori

LingoTori is a local-first browser extension for bilingual reading, user-configured AI translation, vocabulary capture and spaced practice. Its interface supports English, Korean and Japanese; translation language support remains broader.

Bring your own provider and API key in Settings. Fresh installs have no configured provider and make no hosted AI requests. Page translation, selection tools and subtitle translation use the provider you select. Vocabulary and review history are stored locally. An optional personal learning server provides SQLite persistence, a standalone study page and first-party sync; see [learning setup](docs/learning.md).

## ChatGPT plan through a local companion (BYOS)

BYOS connects the extension to your own [local companion](apps/companion/README.md); see [BYOS setup and limitations](docs/byos.md). Credentials stay in the companion's protected local storage. Pair the extension manually using its allowed origin and local pairing secret; do not paste an OpenAI token into the extension. Select an account-authorized model and explicitly assign it to the features you want.

Live account authentication and generation have not been verified in this local validation. Availability depends on account permissions, supported official endpoints and plan limits. Hosted support requires separate approval; this fork does not claim production readiness or silently fall back to an API key.

## Development

Use the Node and pnpm versions declared in `package.json`. Install dependencies with `pnpm install --ignore-scripts`, then run `pnpm exec wxt prepare`. Run `pnpm dev` for extension development, or `pnpm build` / `pnpm build:firefox` for loadable builds. Configure browser extension loading manually. No deployment or paid provider call is required for local validation.

```sh
SKIP_FREE_API=true pnpm test
pnpm type-check
pnpm build
pnpm test:learning
pnpm test:companion
```

The simple interval scheduler is independently authored and versioned. Hosted accounts, billing, telemetry, cloud transcription, speech playback, writing assistance, input translation and executable custom layouts are outside this fork's feature set. Optional user-configured services send only the data needed for an explicitly requested operation; review the endpoint before using a provider.

## Attribution and license

This project is a fork of [Read Frog](https://github.com/mengxi-ream/read-frog), originally authored by its upstream contributors. The original [GNU GPL license](LICENSE) is retained unchanged, and upstream history preserves authorship. LingoTori is an independent fork and is not the upstream hosted service. Newly authored language data, learning core and local server do not depend on the removed `@read-frog` packages.
