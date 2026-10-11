# Experimental browser-only BYOS

Status on 2026-10-11: independently authored **source implementation under mock validation**, not live-verified. The companion runtime, server setup and address/pairing-key UI are removed. No real OAuth registration, sign-in, token exchange, model discovery, inference or installed-browser permission grant was performed in this task.

## Support and architecture distinction

The current documented direct flow requires an actual HTTP listener at `http://127.0.0.1:<port>/auth/callback` before authorization. It also requires protected local/self-hosted runtime storage and explicitly excludes browser token storage. See [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and [accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

The requested experimental architecture differs: it stores tokens in an extension-origin IndexedDB vault and redirects a narrowly scoped loopback navigation to an extension callback page without a listener. It is not established as officially supported, compliant or store-approved. Dynamic public-client registration is supported; there is no borrowed client ID or secret. Passing source/mocked tests does not establish account eligibility or end-to-end browser interoperability.

## User flow

API Providers contains **Sign in with ChatGPT** and independently authored EN/KO/JA guidance. BYOK configuration remains usable and unchanged unless the user explicitly changes a feature assignment. On Chromium, a future direct **Continue with ChatGPT** action requests the optional callback permission. Denial, missing capability or failed rule installation stops before authorization. No permission is requested on startup or settings mount. Firefox authentication is unavailable.

Connection/account state, cancellation, reconnect, sign-out, discovered models and explicit feature assignment share that settings section. There is no companion address or pairing key. Authentication errors never silently switch to another provider or billing path. Usage and first-use guidance must not promise a plan entitlement or invent remaining quota.

## Credential and callback boundaries

- The background owns a dedicated extension-origin IndexedDB vault, separate from ordinary provider settings and config exports/synchronization. Tokens are not stored in `chrome.storage.local` or exposed through generic messages. Existing legacy user records are not read or deleted by this cleanup.
- IndexedDB is not a claim of OS-encrypted storage. Extension-origin pages share the origin; keep the callback minimal, with no remote code, credential-reading interface or unsafe HTML. Ordinary content-script IndexedDB uses the page origin. See [Chrome storage boundaries](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies).
- The manifest declares only an optional Chromium callback permission. A session redirect is restricted to the pending authorization tab, GET/main-frame navigation and the exact loopback host/port/path. Callback accessibility is limited to the known authorization and loopback origins, never a broad fallback. See [declarative request rules](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) and [web-accessible resources](https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources).
- Persist the pending state, nonce, PKCE verifier, tab identity, callback URI, generation and expiry before authorization. Validate exact extension sender/path/frame/tab, reject duplicated or unexpected callback values, consume the transaction once and remove owned rules/tabs on completion, cancellation or expiry.
- Validate ID-token signature, issuer, audience, expiry, nonce, returning identity and granted inference scopes. Keep issued registration identity separate from clearable tokens; retain the app-owned host identity across sign-out.
- Serialize refresh and use persisted generation/version checks so late login or refresh completion cannot restore a signed-out session. An uncertain interrupted refresh rotation requires reconnection. Source error handling must not log or return token bodies.

## Validation and remaining gates

Use synthetic signatures, fake vault/browser transports and fail-closed mocked fetches. Cover permission denial, rule-install timeout and late completion, callback tampering/replay/expiry/wrong sender, worker restart reconciliation, missing scopes, token rotation, concurrent refresh/logout, model discovery and streaming failures. Credential records must remain excluded from content scripts, exported settings, sync, analytics and logs.

Narrow callback accessibility depends on navigation initiator behavior; optional permission/rule installation and real browser restarts need a separately authorized browser acceptance pass. Source mocks do not prove those browser behaviors. No broad callback origin, required-permission fallback or unsupported upstream endpoint may be introduced to conceal a failure. Live authentication and inference remain untested and unauthorized in this task.
