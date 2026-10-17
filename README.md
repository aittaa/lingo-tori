# LingoTori

Read web pages in another language without leaving the page. LingoTori translates pages, selected text and existing video captions, with dictionary meanings and sentence explanations when you need them.

An independent, open-source fork of [Read Frog](https://github.com/mengxi-ream/read-frog), distributed under GPLv3. This is a **development build**; store distribution is not yet confirmed.

## Get started

Developer installation is currently available for desktop Chromium and Firefox. Firefox builds declare version 140 or later; Chromium's supported minimum version still needs release validation.

1. Build the reviewed source with the Node and pnpm versions declared in [package.json](package.json):

   ```sh
   pnpm install --ignore-scripts
   pnpm exec wxt prepare
   pnpm build            # Chromium
   pnpm build:firefox    # Firefox MV3
   ```

2. In Chromium, enable Developer mode at `chrome://extensions` and load `.output/chrome-mv3` unpacked. In Firefox, use `about:debugging` to load `.output/firefox-mv3/manifest.json` temporarily.
3. Open **API Providers**, add a provider or compatible endpoint, then choose a model and check its feature assignments. Experimental **Sign in with ChatGPT** is also available; read its [limitations](docs/byos.md) first.
4. Choose a translation language. Translate a page, select text for an explanation, or enable subtitles on a video that already has captions.

There is no built-in provider on a new installation. Saving a provider does not validate its credentials. Your provider can apply charges and usage limits; LingoTori does not silently switch to a paid fallback.

When an enabled provider is added to an empty provider list, it fills only the empty feature slots it is compatible with; existing choices and each feature's ON/OFF state are unchanged, and for ChatGPT this also needs a connection and an available model. Later providers do not fill slots. There is one translation target language and no separate native-language setting.

Already using a development copy? Preserve the extension ID and profile. **Do not uninstall or clear storage to update.** The version reset from `1.50.3` to `0.0.1` needs care; see [installation and version notes](docs/versioning.md).

## What you can do

- Read pages with bilingual or translation-only rendering.
- Translate selected text and request dictionary meanings, sentence explanations or custom AI actions.
- Translate existing captions on YouTube, X and Netflix. Platform changes can affect support; this does not transcribe audio.
- Keep a glossary and use separate providers for different features.
- Review local request/token statistics, with [measurement limits](docs/api-usage.md).

Smart context and automatic subtitle translation are **OFF by default**. When automatic subtitles are enabled, they start only for a known caption language different from the target language. The interface supports ten languages, with [documented fallbacks](docs/ui-locale-restoration.md).

## Before relying on it

Text, relevant context and matched glossary terms may be sent to the provider you choose, and a custom action can send the address of the page. Providers have their own data and account policies. Read the [privacy notice](docs/privacy.md) for what leaves your browser, what stays on your device and the choices Firefox asks you to make. The notice describes how this version behaves; the operator's jurisdiction, effective date and store listings are not yet decided, and it makes no legal or store-readiness claim.

ChatGPT sign-in is experimental. Earlier user-authorized sessions demonstrated sign-in and Korean subtitles, but they do not verify every current browser/account combination. The browser-only architecture is not established as officially supported or store-approved. No new real-account test is claimed here.

Known limits include active page mode changes that can require OFF then ON, and navigation that may leave an already dispatched provider request running. Cancellation is not a billing guarantee. Shorts lifecycle improvements and mode-transition changes are still design work.

Settings, API keys and backups are stored in your browser profile as plain text. When LingoTori cannot read the stored settings as the current version, it keeps an exact copy of the original and refuses ordinary edits until you choose how to recover, instead of replacing the settings with defaults; see the [privacy notice](docs/privacy.md#preserved-originals-and-recovery-copies). Keep a safely stored backup, review exports for secrets, and avoid sharing them blindly. An export that excludes API keys cannot reliably identify a secret embedded in an arbitrary URL path.

This core does not include voice playback, writing assistance, cloud transcription, vocabulary flashcards or companion services. Translation results can be inaccurate.

## Development and evidence

See [CONTRIBUTING.md](CONTRIBUTING.md), [project documentation](docs/index.md) and the [validation record](docs/validation.md). Browser builds, offline mocks and real-account evidence have different scopes. No test pass is permission to merge or publish.

## License and attribution

LingoTori is licensed under the [GNU GPLv3](LICENSE). Preserve upstream Read Frog authorship and the project [NOTICE](public/NOTICE.txt). The packages and font bundled into the extension, with the license notices they require, are listed in the [third-party notices](public/THIRD_PARTY_NOTICES.txt); the Inter font is licensed under the [SIL Open Font License 1.1](public/licenses/Inter-OFL-1.1.txt). LingoTori is independently maintained; its generated bird branding has [documented provenance](docs/branding/README.md).
