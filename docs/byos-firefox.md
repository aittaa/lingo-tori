# Experimental Firefox BYOS authentication

Firefox 140+ now has the browser-only sign-in routing implementation as well as Chromium. Native QA on Firefox ESR 140.17.0 verified account connection, model discovery and video subtitle translation on the reviewed candidate described below. These results do not establish eligibility for every account, official support, or store approval.

## Callback and permission boundary

The callback page is included in both builds. Firefox declares `declarativeNetRequestWithHostAccess` in `permissions`: Gecko defines it as an install-time, non-prompt API permission and does not accept either routing permission in `optional_permissions`. Firefox checks that declaration and API availability before authorization, without making an unsupported runtime permission request. Chromium keeps its existing optional `declarativeNetRequestWithHostAccess` request directly in the sign-in gesture; denial never falls back to a required permission. Existing host permissions are unchanged. Callback accessibility stays limited to `http://127.0.0.1/*` and `https://auth.openai.com/*`, never a broad callback origin.

Session routing still matches only the owned tab, GET/main-frame navigation, and exact loopback host, port and `/auth/callback` path. Firefox destinations use the UUID returned by `browser.runtime.getURL()`, which differs from the stable add-on ID `lingotori@aittaa`. Sender identity still uses the add-on ID; callback protocol/host/path/frame/tab checks remain exact. PKCE, state, nonce, signature, expiry, generation and consume-once checks are unchanged.

The refused-loopback recovery recognizes Chrome's `net::ERR_CONNECTION_REFUSED` only for Chrome extension URLs. For Firefox it recognizes only `Error code 2152398861`, the current Gecko `NS_ERROR_CONNECTION_REFUSED` (`0x804b000d`) emitted by WebNavigation. Unknown errors, canceled navigations, offline errors, HTTPS-only/security warnings and other failures are rejected. Internal error names can change, so actual Firefox validation remains required. Pending-attempt reconciliation, delayed cleanup, cancellation and replay protection use the shared existing lifecycle.

Primary browser references: [DNR permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest), [Firefox manifest/API schema](https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/extensions/schemas/declarative_net_request.json), [moz-extension URL transforms](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest/URLTransform), [navigation error stability](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webNavigation/onErrorOccurred), [Gecko navigation error formatting](https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/extensions/WebNavigation.sys.mjs), and [Gecko network error definitions](https://github.com/mozilla-firefox/firefox/blob/main/xpcom/base/ErrorList.py).

## Official-flow distinction

This remains the experimental browser-only architecture. OpenAI's documented direct flow requires an actual loopback HTTP listener and protected local/self-hosted runtime token storage, excluding browser token storage. Enabling Firefox does not remove that distinction. See [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and [accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

Firefox's native `identity.launchWebAuthFlow()` is not a drop-in replacement: its allowed redirect forms differ from the required `/auth/callback` loopback. A documented listener/runtime implementation would be a separate architecture decision.

## Validation and acceptance boundary

Synthetic checks cover signed Firefox callbacks with a UUID origin distinct from the add-on ID; foreign origins, IDs, tabs and frames; duplicate/wrong states; expiry and generation; cancel/retry with fresh PKCE/state/nonce; signed nonce/audience rejection; background restart; and refused-navigation replay/retirement. Existing Chromium authentication and routing checks also run with mocked upstream responses. Tests do not contact OpenAI or create real registrations or persistent grants.

On 2026-10-12, user-authorized native QA temporarily installed the build from PR #65 head `aa81b450f827a0b851d8db086ddb03bb7ceb0e29` (tree `8beabfd0bb9d44375821bf2702801b4563989bb5`) in an isolated Firefox ESR 140.17.0 profile. The human completed sign-in; the account connected, seven models were listed, and GPT-6.1-Sol produced Korean subtitles for a real video. No `invalid_stream` error was observed. After terminating the extension background script and reopening settings, the connection, selected model and ChatGPT video-provider assignment remained available without another login. This native evidence applies to that exact candidate, before integration with later main changes.

Full browser restart, token expiry/refresh over time, forced background termination while OAuth is pending, and long-running translation remain **NOT VERIFIED**. The test did not measure the exact upstream request count. Further native checks require their own recorded evidence; a successful background restart does not cover these cases.

Use an isolated Firefox profile for further authorized checks. Firefox has no separate optional DNR prompt; OpenAI account consent remains an explicit user action. Do not disable browser security settings or bypass an authentication warning. Chrome credentials are not transferred to Firefox: the private extension-origin vault belongs to that browser profile and is excluded from config export. Redact authorization URLs and never copy or publish token storage.
