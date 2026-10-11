# Experimental ChatGPT provider follow-up

Browser-only ChatGPT authentication is developed and reviewed separately from the independent BYOK core. This planning PR contains no authentication implementation. The experimental branch has user-confirmed sign-in and model discovery in Chrome; video translation and unified provider editing remain unfinished. Its latest evidence belongs in that feature PR.

## Architecture boundary

The documented OpenAI direct flow starts a real HTTP listener at `http://127.0.0.1:<port>/auth/callback` and uses protected local or self-hosted token storage. See [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and [accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

The experimental browser-only approach differs: extension-origin IndexedDB holds credentials and guarded browser navigation handles the callback without a listener. It is not established as officially supported or store-approved. Keep that limitation explicit without making the unfinished experiment a dependency of the core release.

## Acceptance requirements

- Use the same provider list and editor for account-backed and API-key-backed providers; expose only supported model settings.
- Bind callbacks to an unexpired transaction, exact tab/address, state, nonce and PKCE. Validate identity and granted scopes before enabling model use.
- Keep credentials outside ordinary settings, exports, synchronization, content scripts and logs.
- Preserve credentials through temporary failures, serialize rotating refresh tokens and prevent late completion after logout or cancellation.
- Attempt remote session revocation, report unconfirmed results honestly, and keep feature assignments explicit without billing fallback.
- Verify callback recovery, worker restart, refresh, revocation, account switching and actual translation separately. Sign-in and model listing alone are not inference validation.

Run synthetic tests only at the feature PR's final merge gate. Its incomplete UI, reasoning controls and video-translation investigation remain follow-up work.
