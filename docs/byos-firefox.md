# Experimental Firefox BYOS authentication

Firefox 140+ now has the browser-only sign-in routing implementation as well as Chromium. Real Firefox/OpenAI sign-in is not verified by this draft. Build and synthetic callback checks do not establish account eligibility, inference access, official support, or store approval.

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

Firefox browser runtime, real sign-in, account model discovery, translation and token renewal remain **NOT RUN** until the user approves that stage. Do not disable browser security settings or bypass an authentication warning. Chrome credentials are not transferred to Firefox: the private extension-origin vault belongs to that browser profile and is excluded from config export.

After approval, use an isolated Firefox profile, temporarily load the reviewed build with its declared callback API capability, and complete sign-in through the explicitly opened authorization tab. Firefox has no separate optional DNR prompt; OpenAI account consent remains an explicit user action. Validate the returned account, model discovery, a user-authorized translation, cancellation/retry and browser restart. Redact authorization URLs and never copy or publish token storage.
