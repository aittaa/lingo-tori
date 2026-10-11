# LingoTori

LingoTori is a browser extension for bilingual reading, user-configured AI translation and dictionary explanations. Its interface supports English, Korean and Japanese; translation language support remains broader.

Bring your own provider and API key in Settings. Fresh installs have no configured provider and make no hosted AI requests. Page translation, selection tools and subtitle translation use the provider you select. Existing local vocabulary and review tools are retained. Further learning development, including the optional backend and standalone web prototype, is deferred; these are not prerequisites for translation. See [retained learning components](docs/learning.md) for their current limits.

## Experimental ChatGPT plan integration (BYOS)

The **API Providers** settings include **Sign in with ChatGPT** for experimental BYOS. This requires your own [local companion](apps/companion/README.md); see [BYOS setup and limitations](docs/byos.md). Credentials stay in the companion's protected local storage. Pair the extension manually using its allowed origin and local pairing secret; do not paste an OpenAI token into the extension. Select an account-authorized model and explicitly assign it to the features you want.

Live account authentication and generation have not been verified in this local validation. Availability depends on account permissions, supported official endpoints and plan limits. Hosted support requires separate approval; this fork does not claim production readiness or silently fall back to an API key.

## Development

Use the Node and pnpm versions declared in `package.json`. Install dependencies with `pnpm install --ignore-scripts`, then run `pnpm exec wxt prepare`. Run `pnpm dev` for extension development, or `pnpm build` / `pnpm build:firefox` for loadable builds. Configure browser extension loading manually. No deployment or paid provider call is required for local validation.

```sh
SKIP_FREE_API=true pnpm test
pnpm type-check
pnpm build
pnpm test:companion
```

Current development focuses on reliable first-run settings, provider configuration, translation, dictionary explanations and clear errors. No active learning expansion is planned. Hosted accounts, billing, telemetry, cloud transcription, speech playback, writing assistance, input translation and executable custom layouts are outside this fork's feature set. Optional user-configured services send only the data needed for an explicitly requested operation; review the endpoint before using a provider.

## Attribution and license

This project is a fork of [Read Frog](https://github.com/mengxi-ream/read-frog), originally authored by its upstream contributors. The original [GNU GPL license](LICENSE) is retained unchanged, and upstream history preserves authorship. LingoTori is an independent fork and is not the upstream hosted service. Newly authored language data, learning core and local server do not depend on the removed `@read-frog` packages.
