# Bring your own ChatGPT subscription

Status: design and mock-test plan. Official documentation checked on 2026-10-11. No production readiness or account eligibility is claimed. No credentials were inspected, reused, or generated; no OAuth registration, live sign-in, token exchange, or inference was performed.

## Supported route and deployment decision

**Documented facts:** Sign in with ChatGPT provides identity and optional ChatGPT plan usage as separate capabilities. Eligible Plus and Pro users can authorize plan usage. The public direct flow covers open-source, locally hosted applications; the documentation also describes a user-controlled VM. Commercial access is a limited partner trial. Paid or remotely hosted applications are directed to the partner interest process. Identity-only consent does not authorize inference or expose ChatGPT conversations. See [quickstart](https://developers.openai.com/siwc/quickstart), [plan-usage overview](https://developers.openai.com/siwc/token-sharing-open-source), and [request a client ID](https://developers.openai.com/siwc/request-client-id).

**LingoTori architecture decision:** Implement BYOS first as an optional local companion, with the extension acting as its UI. The translation extension does not require a learning website/backend. Existing learning components are separate prototypes; further backend development is deferred. Never send OpenAI OAuth tokens to a learning backend. Hosted BYOS remains disabled until OpenAI approves the deployment and supplies the applicable contract. Calling a hosted service “open source” does not establish eligibility for the local flow.

Translation and dictionary explanation are text-inference workloads compatible with the documented request shape in principle. The reviewed documentation does not impose a coding-only restriction, but this is not a determination that LingoTori or every user is approved. The repository has a GPLv3 license text; retain existing notices and review distribution obligations before shipping derived components. The SIWC documentation does not specify an accepted-license list or resolve hybrid proprietary/OSS eligibility.

## Boundaries

**Documented facts:** Access, refresh, and retained ID tokens belong in protected local or self-hosted runtime storage, not browser storage, logs, analytics, source control, or support transcripts. Access/refresh tokens must never appear in URLs. An ID token may be supplied as an authorization-endpoint hint, with that URL redacted. See [accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

**Architecture inference:** A browser-only extension cannot implement the documented local listener and protected-runtime storage contract by itself. Use a companion-owned OAuth flow and token store. Prefer browser native messaging for an extension-to-companion transport; if a loopback job service is later chosen, require explicit pairing, strict Origin/Host checks, narrow operations, and request limits. Loopback reachability alone is not authentication. This job transport is separate from the short-lived OAuth callback listener.

Only selected text and the context needed for a translation/explanation job should cross into the companion. The companion returns output, connection state, and safe account/model labels, never OpenAI tokens. Content scripts must not invoke an arbitrary URL proxy. The learning backend and BYOK provider must remain separate from this credential path. An approved commercial backend design will need its own review; the local design is not authorization for vendor token forwarding.

## Registration and authorization contract

The following are documented requirements, not a live integration implementation. Source: [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

- First registration uses `client_id=dynamic_agent_client`, `agent_name_hint=LingoTori`, and a persistent opaque `ext_agent_host_id`. Save the issued callback client ID; use it for exchange and subsequent sign-ins. No client secret or partner API key is required for this public-client flow.
- Open `https://auth.openai.com/api/accounts/authorize` in the system browser with fresh random `state`, OIDC `nonce`, and PKCE S256 values for each attempt.
- Request `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, `response_type=code`, and `resource=https://api.openai.com/v1`.
- Listen on `http://127.0.0.1:<port>/auth/callback` before opening authorization. Only the port may vary between sign-ins. Preserve scheme, host, and path; do not substitute `localhost`, an extension URL, or a hosted callback. Within one attempt, use exactly the same redirect URI in authorization and exchange.
- Validate callback state and errors before exchange. Require an issued ID for a new registration; reject an unexpected replacement client ID on reauthorization.
- Exchange through form-encoded `POST https://auth.openai.com/api/accounts/oauth/token` with the issued client ID, code, verifier, redirect URI, and resource.
- Validate the ID-token signature using published OpenAI JWKS; verify issuer, audience against the issued client ID, expiry, and saved nonce. Use verified `sub` as identity; do not identify a workspace by email. Returning identity must match before replacing credentials. Require the returned direct-plan scope before inference.

OIDC discovery is `https://auth.openai.com/.well-known/openid-configuration`. Bind validation to the expected production issuer `https://auth.openai.com`; do not trust an issuer or key URL supplied by an unverified token. Implementation should use an explicit algorithm allowlist and trusted discovery/JWKS retrieval. These last hardening choices are LingoTori design requirements.

Host IDs identify runtimes, not users or credentials. Generate once per host and retain across restarts/sign-ins. The official overview accepts `urn:uuid:<UUIDv4>`, JWK-thumbprint URIs, and `did:key`; public-key possession is not verified by this flow. A client registration is bound to its user/workspace. Distinct hosts must not share a copied host ID. See [host identifiers](https://developers.openai.com/siwc/token-sharing-open-source).

## Credential lifecycle

**Documented facts:** Store separate records per issued registration and verified identity. Use protected files, atomic replacement, and Unix owner-only permissions. Keep the access token, expiry, granted scopes, and rotating refresh token consistent. Access tokens last one hour; refresh tokens last 30 days and successful refresh returns a replacement with a fresh 30-day lifetime. See [token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference).

Refresh with the saved issued client ID and `resource=https://api.openai.com/v1`, not the bootstrap client ID. Serialize refresh for a session. Revoke the refresh token using the discovery-provided revocation endpoint on sign-out, then clear tokens while retaining account/client and host mappings. If remote revocation is unconfirmed, report that state. Temporary outages must not erase credentials. See [session lifecycle](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

**Implementation choice:** Default to an app-owned config directory outside the repository, mode `0700`, with credential files `0600`. Write a unique same-directory temporary file with exclusive creation, sync it, and rename atomically. Reject symlinks and unsafe permissions; never accept a browser-supplied credential path. Use a per-session refresh lock; a future multiprocess design must add an interprocess lock. Keep secrets out of exceptions and diagnostics. Windows support requires an equivalent protected store/ACL design before claiming parity. Mock tests use only disposable directories and synthetic credentials, never existing Codex or ChatGPT authentication files.

## Model discovery and inference

**Documented facts:** Use the selected account's OAuth token for `GET https://api.openai.com/v1/models`. Read the `models` array, preserve server ordering, show `display_name` for entries with `visibility: "list"`, and send the selected `slug`. Refresh choices after account switching. Do not promise GPT-6 Astra entitlement from a static catalog.

Inference uses bearer authorization at `POST https://api.openai.com/v1/responses`, with `store: false`, `stream: true`, and array-form input. Consume the stream through successful completion; partial output is not completion. Never target ChatGPT `backend-api` endpoints. See [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

The preview rejects fields including `temperature`, `top_p`, `max_output_tokens`, `background`, `conversation`, and HTTP `previous_response_id`. Send required history in input and use `instructions` or developer messages instead of explicit system-message items. Audio/video input, transcription, Files upload, and several hosted tools are unsupported. Use a narrow text-only request allowlist initially and recheck the complete [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) before widening it.

**Architecture choice:** Start with direct Responses streaming. Codex app-server is optional and unnecessary for basic translation. Its documented alternative uses the application's own access token in a child process environment, public Responses transport, and restart/resume after renewal; do not harvest an existing Codex session. See [app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).

The documented [self-hosted VM flow](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) completes OAuth locally, transfers protected credentials securely, preserves the VM's distinct host ID, and assigns refresh ownership to the VM. Transferred-session host-specific usage attribution/revocation is not yet available. This is not a documented multi-tenant hosting permission.

## UI, usage, and failure handling

The sign-in entry belongs inside the existing **API Providers** settings, alongside BYOK configuration. Show **Sign in with ChatGPT** visibly and keep the official **Continue with ChatGPT** action recognizable. Connection/account state, reconnect, disconnect and discovered-model assignment belong in that same flow; a separate route or pairing form alone is insufficient. Existing BYOK choices must remain unchanged until the user explicitly assigns BYOS.

This integration is experimental and live account sign-in/inference has not been verified. Independently authored EN/KO/JA guidance must expose the required user-controlled local companion, extension-origin allowlist and pairing setup before sign-in. Disable unavailable sign-in/model actions, explain the missing prerequisite, and distinguish an unpaired extension from an unverified account or a temporary service failure. Pairing configuration is not successful OAuth. No credentials or live login are needed for the current mock validation.

Use the recognizable Continue with ChatGPT action and approved branding, with a visible active account. Distinguish application sign-in from permission to use a plan. Show BYOK and BYOS as explicit user choices; never silently change billing after BYOS failure. Follow [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines).

Expose disconnected, connecting, identity-only, plan-enabled, restricted, limit-reached, reconnect-required, and temporarily-unavailable states. Link usage management to ChatGPT Settings rather than inventing remaining quota. Plus shares a five-hour allowance across participating apps; the documented five-hour limit does not apply to Pro. Do not infer unlimited usage from that distinction. See [usage tracking](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

Preserve sanitized HTTP status, actual error shape/code, and request ID. Admission may return a `detail` body instead of the standard API error object. Stop on ineligibility/permission failures; pause on usage limits; retry temporary failures with bounded backoff. Do not infer a reset time or exhausted entire plan from a limit error. Terminal refresh failures require fresh authorization using the saved registration. See [errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).

## Acceptance and release gates

The first implementation phase is fully offline and mock-only. It must not open authorization, register a client, read existing credentials, exchange tokens, call model discovery, or perform paid/subscription inference. A transport injected by tests must fail closed on any unmocked request.

Mock acceptance checks include the API Providers entry, preserved BYOK configuration, missing prerequisites, disconnected/connected/reconnect states, explicit model assignment, and safe disconnection. Installed-browser settings checks remain distinct from live sign-in.

Protocol mock acceptance checks:

1. Generate deterministic-testable state/nonce/PKCE and host metadata; reject callback mismatch, denial, missing issued ID, or unexpected returning ID.
2. Verify synthetic signed ID tokens against test-owned keys; reject wrong issuer/audience/nonce, expired tokens, altered signatures, and unsupported algorithms. Missing direct scope leaves inference disabled.
3. Keep registrations isolated; atomically replace token sets; serialize refresh; verify permissions, symlink rejection, restart state, and redacted diagnostics.
4. Filter an account-specific model fixture and construct only allowed Responses fields. Fail on `backend-api` or arbitrary target hosts.
5. Parse fragmented streaming fixtures through completion; distinguish failed, incomplete, interrupted, and disconnected streams from success.
6. Cover documented admission/limit/refresh errors, bounded retries, sign-out revocation failure, account switching, and no automatic BYOK fallback.
7. Verify the extension/backend contract cannot read, export, or log OpenAI tokens and cannot submit arbitrary proxy requests.

Use Node built-ins (`node:test`, `node:assert/strict`, `node:crypto`, `node:fs/promises`, and injected fetch/streams) for the isolated companion scaffold. These tests validate local logic only; they do not establish OpenAI eligibility or production OAuth interoperability.

Live tests are not run. A later authorized acceptance pass must verify actual consent, account/workspace eligibility, current model catalog, one bounded successful streamed request, refresh, and revocation in a supported deployment. Hosted release additionally requires partner approval. Do not mark any of these gates complete from mocks or this document.
