# BYOK setup

BYOK means using a provider account, endpoint and API key that you control. The independent core supports page and selected-text translation, dictionary actions, original reading suggestions and translation of existing video captions.

1. Open LingoTori's settings and select **API Providers**. A fresh install can open settings before any provider is configured.
2. Add your provider. Enter its API key, model and endpoint or provider-specific settings as needed. Gemini and Azure are among the supported provider types; Azure uses your deployment settings.
3. In **Feature providers**, explicitly choose the provider for each feature you want to use. Custom AI actions also have their own provider selection.
4. Choose source and target languages. Interface language is a separate preference supporting English, Korean and Japanese. Chinese and other translation languages remain available.
5. Invoke translation when ready. Provider requests use the endpoint you configure and may incur charges. No live request is required to build the extension or run its offline merge checks.

For example, select English text and translate it to Korean, look up a Japanese word with the Dictionary action, or translate a video's existing English captions to Japanese. Captions must be available from the video platform; LingoTori does not transcribe audio in this core.

If a provider is missing or disabled, configure and explicitly select one. Multiple BYOK providers and per-feature assignments remain supported. There is no automatic paid fallback. Existing glossary and user records are not cleanup targets.

As of 2026-10-12, main `d1bba610634c7000dd930743f39948274e743271` includes experimental browser-only ChatGPT BYOS from [PR58](https://github.com/aittaa/lingo-tori/pull/58). An enabled account provider can execute requests after sign-in, model selection and explicit feature assignment; account-provider records are no longer storage-only. This experiment is not established as officially supported. Translation Hub / multi-API text translation was removed in [PR59](https://github.com/aittaa/lingo-tori/pull/59), while page, selection and video translation remain.

Config exports can contain credentials. Exporting without API keys removes only fields named exactly `apiKey`; credentials in custom headers such as `Authorization` or `x-api-key`, provider options or other fields may remain. Before sharing any export, inspect it and manually remove all credentials, including custom headers and options. Do not assume that this export option makes a file safe to share. Builds must not embed credentials in `WXT_` environment variables.

## Firefox data consent

Firefox 140 and later asks for consent before an add-on sends data away, and LingoTori declares what it sends. The page, selected and subtitle text that every translation sends to your provider is declared as required (`websiteContent`), so Firefox shows it when you install. Two more categories are optional and stay off until you allow them, in the buttons on the settings pages or later in `about:addons`:

- **Authentication info** (`authenticationInfo`) is needed when a request carries a credential: a non-empty API key, a header such as `Authorization` or `x-api-key`, credentials in the endpoint URL, a credential-named provider option, or the ChatGPT sign-in. A provider with none of these, such as a local server you reach without a key, works without the permission.
- **Browsing activity** (`browsingActivity`) is needed when a custom action, or the note suggestion built from one, uses the page-URL token in its prompt, system prompt or an output-field description, because that puts the address of the current page into the request.

Without the permission LingoTori does not start the request and says what to allow. The permission is read for every new request, so turning it off in `about:addons` stops the next request, including a retry. A request that has already started may finish. Signing out of ChatGPT always clears the local tokens; without the permission the remote revocation is skipped and reported as unconfirmed.

LingoTori recognises a credential by its name. It cannot see a secret placed in an opaque part of the endpoint URL, in an option or header with a name it does not recognise, so it cannot ask first for those. If an endpoint URL or its options contain a secret, tick **This endpoint URL or its options contain a secret** in that provider's settings; Firefox then asks first, as it does for an API key. The setting only adds to what is detected. Chrome builds do not use this mechanism, and Firefox for Android and Firefox older than 140 are not supported.

See the [experimental BYOS flow and limitations](byos.md) and the [validation evidence and merge gate](validation.md) for the revisions and scenarios actually checked.
