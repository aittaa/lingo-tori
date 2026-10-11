# LingoTori local companion

Experimental local OSS SIWC implementation. All automated validation uses synthetic tokens and mocked OpenAI responses. No live registration, token issuance, or inference has been run. Review ../../docs/byos.md before enabling. Hosted/commercial use requires the applicable OpenAI approval.

Node 26.11.1+, Unix protected storage. No dependencies. Run `node --test apps/companion/test/*.test.mjs` from the repository root.

Explicit runtime configuration (do not use guessed extension IDs):

- `LINGOTORI_COMPANION_ENABLE=1`
- `LINGOTORI_COMPANION_CONFIG_DIR`: absolute app-owned directory outside source control; created as 0700. Tokens and bridge secret use separate 0600 files.
- `LINGOTORI_COMPANION_PORT`: explicit port 1024–65535.
- `LINGOTORI_EXTENSION_ORIGINS`: comma-separated actual chrome-extension:// or moz-extension:// origins, without trailing slash.

Then run `node apps/companion/src/server.mjs`. Starting creates a local bridge secret; it does not register with OpenAI or start OAuth. Pair the extension by manually copying `secret` from the protected `bridge.json` file; do not upload or commit it. This local secret can initiate subscription usage, so keep it in the extension's private local IndexedDB storage; it is never placed in browser sync storage. The runtime never logs its value. There is no unauthenticated pairing endpoint. Stop the process and remove bridge.json to rotate pairing. After an unclean exit, inspect the process before manually removing a stale runtime.lock.

All `/v1/*` calls require an exact configured extension identity, exact loopback Host, and `Authorization: Bearer <bridge secret>`. Ordinary browser requests must have an allowed Origin. Privileged extension background requests that omit Origin must supply `X-LingoTori-Extension-Origin`; when both headers are present they must agree. This identity header does not authenticate the caller: the pairing bearer is always required. Preflights require an actual allowed Origin and cannot use the fallback. POST bodies require application/json; unrecognized fields fail. CORS preflight grants only configured extension origins. No wildcard, website-origin access, or arbitrary URL forwarding is supported. This boundary protects against arbitrary websites, not hostile software already running as the OS user.

| Method/path         | Input                        | Output                                                                   |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| GET /v1/session     | none                         | `{state, account?: {subject,email}}`                                     |
| POST /v1/auth/start | `{}`                         | `{authorizationUrl}`; extension opens it only after explicit user action |
| GET /v1/models      | none                         | `{models:[{slug,display_name}]}`                                         |
| POST /v1/translate  | `{model,text,instructions?}` | `{text}` after validated upstream stream completion                      |
| POST /v1/signout    | `{}`                         | `{state,account?,remoteRevocationConfirmed}`                             |

Translation requests permit up to 50,000 text characters and 30,000 instruction characters (including structured-output schema instructions), with a bounded 500,000-byte JSON body. Cancelling a request disconnects the bridge operation and aborts its upstream request; cancellation cannot undo usage already accepted upstream.

Errors are `{error:{code}}` with HTTP status. /auth/callback is the sole unauthenticated route: fresh state, nonce, PKCE, issued-client matching, and signed ID-token checks protect it. It must not be called by the extension to bypass browser consent. The authorization URL contains a temporary state/PKCE challenge, not tokens; do not log it.

The initial adapter buffers streaming deltas and returns only completed output. It permits one active operation, returns 409 busy for concurrent jobs, and never falls back to BYOK. UI should pause and ask the user to retry after limit errors; reconnect can clear locally blocked status, but does not bypass upstream limits. One persisted registration is supported initially; sign out/reconnect preserves that registration. A multi-account picker is deferred.

Production gates: live interoperability; additional account management; independently reviewed local pairing; retry/diagnostics improvements; Windows protected-store support. Discovery JWKS are restricted to auth.openai.com and only RS256 is accepted; verify the live provider's advertised signing algorithm before release. Do not weaken signature checking to accommodate a mismatch. Files contain bearer credentials protected by OS permissions, not encryption at rest.

Security review additions: authenticated HTTP 401 triggers at most one serialized refresh and retry, then requires reconnect if rejected again. Malformed or post-completion stream deltas fail closed. Sign-out disables in-memory credentials even if local persistence fails; a storage failure remains an error, and existing disk credentials require repair/removal before restarting. No live-service security claim is made from mocked tests.
