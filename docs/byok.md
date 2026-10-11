# BYOK setup

BYOK means using a provider account, endpoint and API key that you control. The independent core supports page and selected-text translation, dictionary actions, original reading suggestions and translation of existing video captions.

1. Open LingoTori's settings and select **API Providers**. A fresh install can open settings before any provider is configured.
2. Add your provider. Enter its API key, model and endpoint or provider-specific settings as needed. Gemini and Azure are among the supported provider types; Azure uses your deployment settings.
3. In **Feature providers**, explicitly choose the provider for each feature you want to use. Custom AI actions also have their own provider selection.
4. Choose source and target languages. Interface language is a separate preference supporting English, Korean and Japanese. Chinese and other translation languages remain available.
5. Invoke translation when ready. Provider requests use the endpoint you configure and may incur charges. No live request is required to build the extension or run its offline merge checks.

For example, select English text and translate it to Korean, look up a Japanese word with the Dictionary action, or translate a video's existing English captions to Japanese. Captions must be available from the video platform; LingoTori does not transcribe audio in this core.

If a provider is missing or disabled, configure and explicitly select one. Old experimental account-provider records are retained for configuration compatibility but cannot run requests here. There is no automatic paid fallback. Existing glossary and user records are not cleanup targets.

Config exports can include API keys; choose the export without API keys when sharing settings. Builds must not embed credentials in `WXT_` environment variables.

[Experimental BYOS status](experimental-byos.md) is tracked separately. Consult the [validation gate](validation.md) for remaining checks on the draft core.
