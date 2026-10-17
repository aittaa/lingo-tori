# LingoTori privacy notice

This notice describes what the LingoTori browser extension does with your data: what leaves your browser and where it goes, and what stays on your device. It follows what the source code does, as reviewed for this version. It is a plain description for users, not a legal privacy policy, and nothing in it says LingoTori is ready for a store listing or satisfies the law of any country.

LingoTori is a free, independent extension under the GNU General Public License, version 3. It has no account system, no server of its own and no advertising. It translates web pages, selected text and the existing captions of videos, and gives dictionary meanings and sentence explanations, by sending text to an AI provider **that you choose and configure**.

## Who is responsible

|             |                                      |
| ----------- | ------------------------------------ |
| Operator    | 김현                                 |
| Contact     | hyeonkim.develop@gmail.com           |
| Source code | https://github.com/aittaa/lingo-tori |

These details are **not yet decided** and this notice does not state them:

- the jurisdiction or governing law that applies to LingoTori;
- whether LingoTori will have any revenue model or paid plan;
- an effective date for this notice, and how changes to it will be announced;
- the web addresses of any store listing (Chrome Web Store, Firefox Add-ons or others).

Until they are decided, the history of this file in the source repository is the record of what it said and when.

## In short

- LingoTori sends the text you ask it to translate or explain to the AI provider you set up. It does this from your browser, with your API key or your ChatGPT sign-in. The project does not receive that text.
- What your provider does with the text is governed by the provider's own terms and privacy policy. LingoTori cannot control or guarantee it.
- Settings, API keys, backups, caches and usage statistics are stored in your browser profile. API keys are stored as plain text in the extension's storage; the browser does not encrypt them for you.
- LingoTori contains no analytics or crash reporting that sends usage events to the project or to a third party. Usage statistics on the settings page are kept on your device only.
- A few things are loaded from public hosts for display: provider logos from unpkg and some icons from the Iconify service (see [Public asset hosts](#public-asset-hosts)).

## What leaves your browser, and where it goes

### Text sent to your AI provider

When you translate a page, a selection or video captions, or use a dictionary, explanation or custom AI action, LingoTori sends a request to the provider you selected for that feature. The request contains:

- the text to translate or explain: the selected text, the paragraphs of the page being translated, or the caption lines of a video;
- the instructions (prompt) for the task, the languages, and the model name;
- the API key, authorization header or other credential you configured for that provider, so the provider can accept the request;
- for some features, matched glossary entries: the glossary terms found in the text. The whole glossary is not sent every time.

The provider can be a hosted service, an OpenAI-compatible endpoint you entered, or a server on your own computer or network. LingoTori sends nothing to a provider you have not selected, and it does not fall back to another provider or a paid plan on its own.

Cancelling a translation in LingoTori stops the browser's request. It does not guarantee that the provider stops processing the request or does not charge for it.

Your use of a provider is subject to the limits, costs and data terms of your account or API key with that provider.

### Smart context (off by default)

Page translation has an optional smart context setting. It is **off by default**. When you turn it on, LingoTori first asks your provider to summarise the page, which sends the page title and the page's text content (cleaned up, and possibly shortened), and it then includes the resulting summary in the translation requests for that page. This sends more of the page than the paragraphs being translated. Leave it off if you do not want that to reach your provider.

### The page address in custom actions and note suggestions

A custom AI action, and the note suggestion built from one, can use the `{{webUrl}}` placeholder in its prompt. When it does, the **full address (URL) of the current page** is sent to your provider along with the text, and the address may contain information such as search terms or identifiers. Actions that do not use the placeholder do not send the address. The note suggestion is a feature of the selection toolbar and sends its request in the same way.

### Translated pages may contain private content

LingoTori translates whatever text is on a page when you translate it. If that page is webmail, a chat, a document, a bank or any other private page, the text on it that is translated is sent to your provider like any other text. Translate only pages whose content you are willing to send to that provider. Pages you do not translate are not sent, and websites are not sent anything by LingoTori that you did not cause.

### Signing in with ChatGPT (experimental)

If you use the experimental **Sign in with ChatGPT** option instead of an API key, LingoTori's background part talks to OpenAI as follows:

- It registers itself as a public client and runs the standard OAuth sign-in with PKCE against `auth.openai.com`, and it uses `api.openai.com` for model lists and requests.
- It sends your translation requests to OpenAI with the access token issued to your account. OpenAI's account terms apply.
- The sign-in tokens are kept in a separate database that only the extension's background part reads, apart from ordinary settings. That database is not protected by the operating system's encryption. It is excluded from settings exports, backups and the page-side scripts.
- **Signing out** always clears the tokens from your browser immediately. LingoTori then asks OpenAI to revoke the refresh token. Only a successful answer from OpenAI confirms the revocation; otherwise LingoTori tells you it is **unconfirmed**. On Firefox, if you have not allowed the "authentication info" data permission (see [Firefox data consent](#firefox-data-consent)), LingoTori does not send the revocation request at all. The local tokens are still cleared, and the remote revocation is reported as unconfirmed. You can revoke access from your OpenAI account yourself.

This sign-in is an experiment. It is not an official or store-approved integration, and it does not imply any partnership with OpenAI.

### Public asset hosts

Two kinds of display assets are fetched from public hosts when you use the settings pages:

- **Provider logos**: the logos shown for the providers you have selected are loaded from `unpkg.com`. unpkg can see your IP address and which logo file was requested, which tells it which provider logo was shown.
- **Icons**: some interface icons come from the Iconify service (`api.iconify.design`). Iconify can see your IP address and the icon-set and icon names requested (for example, `tabler:api`).

These requests carry none of your text, settings or keys. If you block these hosts, the extension still works; logos or icons may be blank.

### What LingoTori does not send

Based on a review of the source code for this version, LingoTori does not send your translated text, settings, usage statistics, or an identifier for you to any server run by the project or to an analytics service. The earlier analytics code is a no-op in this version, and the usage page is described below. This statement comes from reading the code; it is not the result of capturing every possible network request.

## What stays on your device

LingoTori stores the following in your browser profile, in the extension's own storage. Uninstalling the extension removes this data from the profile. It cannot remove anything a provider has kept.

### Settings, keys and glossary

Your settings (providers, API keys, custom headers, languages, shortcuts, site rules and custom actions) are stored in the extension's local storage. Your glossary is stored in the extension's local database. API keys and header values are stored as plain text. Anyone who can read your browser profile can read them.

### Backups

LingoTori automatically takes a copy of your settings about once an hour when they changed, and keeps the newest eight; you can also back up on demand. A backup is a full copy of your settings, **including API keys**. Backups are stored in the same local storage and are not synchronised to any server by LingoTori.

### Preserved originals and recovery copies

<!-- TODO: verify this section against the merged config-preservation change before this notice is published. -->

If LingoTori finds that the stored settings cannot be read as the current version (for example because they are damaged, or an upgrade step failed), it does not overwrite them with defaults. It first keeps an **exact copy of the stored original** in separate storage that the hourly backup rotation does not touch, and it asks you to choose how to recover. Until you do, ordinary edits to the settings are refused with a pointer to the recovery notice, and exporting "current settings" is blocked so that defaults are not exported as if they were yours.

- A preserved original is an exact copy of your stored settings. **It can contain API keys and other secrets**, exactly as the original did. "Export exact JSON" in the recovery notice writes it to a file that you must keep as carefully as a key.
- LingoTori keeps at most five preserved originals. It never deletes one by itself. A preserved original is removed only when you choose **Delete** and confirm, or when you uninstall the extension.
- Restoring or starting from defaults is always your explicit action, and it takes effect only after the original has been verified as preserved.
- These protections cover damage that LingoTori can detect. A write interrupted by the browser or the operating system may still need your recovery. LingoTori does not claim that the browser's storage is crash-proof, and it relies on the extension having one background context.

### Translation cache and private windows

To avoid asking your provider twice for the same text, LingoTori caches translations in a local database for **seven days** and then deletes them. It likewise caches page summaries and AI segmentation results for seven days. Requests from **private (incognito) windows** are not read from or written to these persistent caches, and they use their own request queue. Private windows still send text to your provider when you translate there; the isolation covers the local caches only, and it does not make the use of a provider private.

### Usage statistics (local only)

The usage page shows how many requests LingoTori dispatched and the token counts your provider reported, by day, model and feature. It is computed and stored only on your device and is never sent anywhere. LingoTori does not delete it automatically; it stays until you remove the extension or clear the extension's storage in your browser. It can be incomplete if a write fails or the background stops, and it is a record of requests, not a bill: your provider's invoice is the reference.

A second, small local record counts how many requests batching saved. Each entry holds a random identifier, a date, a request count and the provider and model names, with no text. It keeps at most 10,000 entries for 120 days.

## Exporting your settings

You can export your settings to a file. The export can leave out API keys. This removes fields and endpoint address parts that LingoTori recognises as credentials by name, for example a field called `apiKey`, an `Authorization` header, a credential-named option, a user name and password in an address, or a credential-named address parameter. **It cannot recognise a secret placed in an ordinary-looking part of an endpoint address**, such as an opaque path segment, or in an option or header with an unrecognisable name. Before you share an export, open it and check it. Do not treat any export as safe to publish.

## Firefox data consent

Firefox 140 and later asks add-ons to declare the data they send away and gets your consent for it. LingoTori declares:

- **Website content, required.** Every translation sends page, selected or caption text to your provider, so Firefox shows this category when you install. Mozilla documents that a user who does not accept a required category can cancel the installation.
- **Authentication info, optional and off until you allow it.** It is needed when a request carries a credential: an API key, a header such as `Authorization`, credentials in the endpoint address, a credential-named provider option, or the ChatGPT sign-in. A provider with none of these, for example a local server that needs no key, works without it.
- **Browsing activity, optional and off until you allow it.** It is needed when a custom action, or the note suggestion built from one, uses `{{webUrl}}`, because that sends the address of the current page.

You can allow these from the buttons on the settings pages or later in `about:addons`. Without the permission LingoTori does not start the request and says what to allow. It checks the permission before every new request, so switching it off in `about:addons` stops the next request, including a retry. A request that has **already started may finish**. If an endpoint address or its options hide a secret that LingoTori cannot recognise, tick "This endpoint URL or its options contain a secret" in that provider's settings so that Firefox asks first; this adds to what LingoTori detects and never removes a check. Chrome builds do not use this mechanism. Firefox for Android and Firefox older than 140 are not supported.

Checks of this behaviour in a real Firefox use a temporary add-on installation. **The consent dialog Firefox shows when you install a signed add-on, what it lists as required and optional, and what happens when a required category is declined, have not been verified.** That part rests on Mozilla's documentation.

## Endpoints you enter, including HTTP and local networks

You can enter any endpoint address for a custom or OpenAI-compatible provider, including an `http://` address and an address on your own computer or local network. LingoTori does not block or warn about these, and this has not changed. A plain `http://` request is not encrypted in transit, so anyone on the network path can read the text and any key in it. Use `https://`, or a server you fully control. Whether LingoTori should restrict or warn about such endpoints is **not yet decided**.

## Limits of this notice

- It describes this version of LingoTori. A different version can behave differently, and the repository history shows how this notice changed.
- It comes from reading the source and from the tests in the repository, not from a complete capture of every network request in every code path, and so it cannot promise that nothing else is ever sent.
- Providers, hosts, websites and your browser have their own policies. This notice does not describe them and does not replace them.

## Contact

Questions or corrections: 김현, hyeonkim.develop@gmail.com. Issues can also be reported at https://github.com/aittaa/lingo-tori/issues.
