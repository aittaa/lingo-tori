import { randomBytes, createHash, createPublicKey, verify, randomUUID } from "node:crypto"
export const ISSUER = "https://auth.openai.com"
export const RESOURCE = "https://api.openai.com/v1"
export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`
export const SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
export class CompanionError extends Error {
  constructor(code, status = 400) {
    super(code)
    this.code = code
    this.status = status
  }
}
const fail = (code, status) => {
  throw new CompanionError(code, status)
}
export function validateIdToken(token, jwks, { clientId, nonce, now = Date.now() / 1000 }) {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) fail("invalid_id_token")
    const header = JSON.parse(Buffer.from(parts[0], "base64url"))
    const claims = JSON.parse(Buffer.from(parts[1], "base64url"))
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.crit)
      fail("invalid_id_token")
    const keys = jwks.keys.filter(
      (k) =>
        k.kid === header.kid &&
        k.kty === "RSA" &&
        (!k.use || k.use === "sig") &&
        (!k.alg || k.alg === "RS256"),
    )
    if (keys.length !== 1) fail("invalid_id_token")
    const key = createPublicKey({ key: keys[0], format: "jwk" })
    if (
      key.asymmetricKeyDetails.modulusLength < 2048 ||
      !verify(
        "RSA-SHA256",
        Buffer.from(parts.slice(0, 2).join(".")),
        key,
        Buffer.from(parts[2], "base64url"),
      )
    )
      fail("invalid_id_token")
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (
      claims.iss !== ISSUER ||
      !audiences.includes(clientId) ||
      (audiences.length > 1 && claims.azp !== clientId) ||
      (claims.azp && claims.azp !== clientId) ||
      claims.nonce !== nonce ||
      typeof claims.exp !== "number" ||
      claims.exp <= now ||
      (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now)) ||
      typeof claims.sub !== "string" ||
      !claims.sub
    )
      fail("invalid_id_token")
    return claims
  } catch {
    return fail("invalid_id_token")
  }
}
export class Companion {
  constructor({
    store,
    redirectUri,
    fetcher = fetch,
    random = () => randomBytes(32).toString("base64url"),
    now = () => Date.now(),
  }) {
    Object.assign(this, { store, redirectUri, fetcher, random, now })
    const redirect = new URL(redirectUri)
    if (
      redirect.hostname !== "127.0.0.1" ||
      redirect.protocol !== "http:" ||
      redirect.pathname !== "/auth/callback" ||
      redirect.search ||
      redirect.hash ||
      redirect.username ||
      redirect.password
    )
      fail("invalid_redirect_uri")
    this.pending = null
    this.refreshing = null
    this.blocked = null
  }
  async initialize() {
    this.record = await this.store.read()
  }
  session() {
    return {
      state:
        this.blocked ||
        (!this.record?.access_token
          ? "disconnected"
          : this.record.scopes?.includes("chatgpt.tokens.use.direct")
            ? "plan-enabled"
            : "identity-only"),
      ...(this.record?.subject
        ? { account: { subject: this.record.subject, email: this.record.email || "" } }
        : {}),
    }
  }
  async startAuth() {
    const host = this.record?.hostId || `urn:uuid:${randomUUID()}`
    if (!this.record) {
      this.record = { hostId: host }
      await this.store.write(this.record)
    }
    const state = this.random(),
      nonce = this.random(),
      verifier = this.random()
    this.pending = {
      state,
      nonce,
      verifier,
      expires: this.now() + 300000,
      clientId: this.record.client_id,
      subject: this.record.subject,
    }
    const url = new URL(`${ISSUER}/api/accounts/authorize`)
    const params = {
      client_id: this.record.client_id || "dynamic_agent_client",
      ext_agent_host_id: host,
      response_type: "code",
      redirect_uri: this.redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }
    if (!this.record.client_id) params.agent_name_hint = "LingoTori"
    url.search = new URLSearchParams(params).toString()
    return { authorizationUrl: url.href }
  }
  async request(url, options = {}) {
    const u = new URL(url)
    if (
      u.protocol !== "https:" ||
      !["auth.openai.com", "api.openai.com"].includes(u.hostname) ||
      u.username ||
      u.password ||
      u.port
    )
      fail("invalid_upstream")
    return this.fetcher(u.href, {
      ...options,
      redirect: "error",
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000),
    })
  }
  async authenticatedRequest(url, options = {}) {
    const token = await this.accessToken()
    const invoke = (accessToken) =>
      this.request(url, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${accessToken}` },
      })
    let response = await invoke(token)
    if (response.status === 401) {
      await response.body?.cancel()
      // Another caller may already have rotated this token. Never rotate it twice.
      if (this.record?.access_token === token) await this.refreshTokens()
      response = await invoke(await this.accessToken())
      if (response.status === 401) this.blocked = "reconnect-required"
    }
    return response
  }
  async json(url, options, authenticated = false) {
    const response = authenticated
      ? await this.authenticatedRequest(url, options)
      : await this.request(url, options)
    if (!response.ok) {
      let body = {}
      try {
        body = await response.json()
      } catch {}
      const code = body?.error?.code || body?.error
      if (
        options?.body?.get?.("grant_type") === "refresh_token" &&
        [
          "invalid_grant",
          "invalid_refresh_token",
          "token_expired",
          "refresh_token_expired",
          "refresh_token_invalidated",
          "refresh_token_reused",
        ].includes(code)
      ) {
        await this.clearTokens()
        this.blocked = "reconnect-required"
      }
      if (response.status === 429) this.blocked = "limit-reached"
      if (response.status === 403) this.blocked = "restricted"
      // Do not expose arbitrary upstream diagnostic text or token-bearing payloads.
      fail(
        response.status === 429
          ? "usage_limit"
          : response.status === 403
            ? "restricted"
            : "upstream_failure",
        response.status,
      )
    }
    return response.json()
  }
  async callback(params) {
    const pending = this.pending
    if (!pending || params.get("state") !== pending.state || pending.expires < this.now())
      fail("invalid_oauth_state")
    this.pending = null
    if (params.has("error")) fail("consent_denied")
    const clientId = params.get("client_id") || pending.clientId
    if (
      !clientId ||
      clientId === "dynamic_agent_client" ||
      (pending.clientId && clientId !== pending.clientId) ||
      !params.get("code")
    )
      fail("invalid_oauth_callback")
    if (!pending.clientId) {
      this.record = { ...this.record, client_id: clientId }
      await this.store.write(this.record)
    }
    const tokens = await this.json(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: params.get("code"),
        code_verifier: pending.verifier,
        redirect_uri: this.redirectUri,
        resource: RESOURCE,
      }),
    })
    const discovery = await this.json(`${ISSUER}/.well-known/openid-configuration`)
    if (discovery.issuer !== ISSUER || new URL(discovery.jwks_uri).origin !== ISSUER)
      fail("invalid_discovery")
    const claims = validateIdToken(tokens.id_token, await this.json(discovery.jwks_uri), {
      clientId,
      nonce: pending.nonce,
      now: this.now() / 1000,
    })
    if (pending.subject && pending.subject !== claims.sub) fail("account_mismatch")
    await this.saveTokens(tokens, { client_id: clientId, subject: claims.sub, email: claims.email })
    this.blocked = null
    return this.session()
  }
  async saveTokens(tokens, extra = {}) {
    if (
      typeof tokens.access_token !== "string" ||
      !tokens.access_token ||
      typeof tokens.refresh_token !== "string" ||
      !tokens.refresh_token ||
      tokens.token_type?.toLowerCase() !== "bearer" ||
      !Number.isFinite(tokens.expires_in) ||
      tokens.expires_in <= 0 ||
      typeof tokens.scope !== "string"
    )
      fail("invalid_token_response")
    const next = {
      ...this.record,
      ...extra,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token || this.record?.id_token,
      scopes: tokens.scope.split(" "),
      expires_at: this.now() + tokens.expires_in * 1000,
    }
    await this.store.write(next)
    this.record = next
  }
  async refreshTokens() {
    this.refreshing ||= (async () => {
      if (!this.record?.refresh_token || !this.record?.client_id)
        fail("plan_permission_required", 401)
      const tokens = await this.json(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: this.record.client_id,
          refresh_token: this.record.refresh_token,
          resource: RESOURCE,
        }),
      })
      await this.saveTokens(tokens)
    })().finally(() => {
      this.refreshing = null
    })
    await this.refreshing
  }
  async accessToken() {
    if (!this.record?.access_token || !this.record.scopes?.includes("chatgpt.tokens.use.direct"))
      fail("plan_permission_required", 401)
    if (this.blocked) fail(this.blocked, 403)
    if (this.record.expires_at <= this.now() + 60000) await this.refreshTokens()
    if (!this.record?.access_token || !this.record.scopes?.includes("chatgpt.tokens.use.direct"))
      fail("plan_permission_required", 401)
    return this.record.access_token
  }
  async models() {
    const data = await this.json(`${RESOURCE}/models`, {}, true)
    if (!Array.isArray(data.models)) fail("invalid_models")
    return {
      models: data.models
        .filter(
          (m) =>
            m.visibility === "list" &&
            typeof m.slug === "string" &&
            typeof m.display_name === "string",
        )
        .map(({ slug, display_name }) => ({ slug, display_name })),
    }
  }
  async translate(
    { model, text, instructions = "Translate the supplied text accurately." },
    signal,
  ) {
    signal?.throwIfAborted()
    if (
      typeof model !== "string" ||
      !model ||
      model.length > 256 ||
      typeof text !== "string" ||
      !text ||
      text.length > 50000 ||
      typeof instructions !== "string" ||
      instructions.length > 30000
    )
      fail("invalid_request")
    const response = await this.authenticatedRequest(`${RESOURCE}/responses`, {
      signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions,
        input: [{ role: "user", content: text }],
        store: false,
        stream: true,
      }),
    })
    if (!response.ok) {
      if (response.status === 429) this.blocked = "limit-reached"
      if (response.status === 403) this.blocked = "restricted"
      fail(response.status === 429 ? "usage_limit" : "inference_failed", response.status)
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream")) fail("invalid_stream")
    let buffer = "",
      output = "",
      completed = false,
      bytes = 0
    const decoder = new TextDecoder()
    const consume = (block) => {
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n")
      if (!data || data === "[DONE]") return
      let event
      try {
        event = JSON.parse(data)
      } catch {
        fail("invalid_stream")
      }
      if (!event || typeof event !== "object" || typeof event.type !== "string" || completed)
        fail("invalid_stream")
      if (["response.failed", "response.incomplete", "error"].includes(event.type))
        fail("inference_failed")
      if (event.type === "response.output_text.delta") {
        if (typeof event.delta !== "string") fail("invalid_stream")
        output += event.delta
      }
      if (event.type === "response.completed") {
        if (event.response?.status !== "completed") fail("inference_incomplete")
        completed = true
      }
    }
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > 4000000) fail("response_too_large")
      buffer += decoder.decode(chunk, { stream: true })
      buffer = buffer.replace(/\r\n/g, "\n")
      let end
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        consume(buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) consume(buffer)
    if (!completed) fail("inference_incomplete")
    return { text: output }
  }
  async clearTokens() {
    const { hostId, client_id, subject, email } = this.record || {}
    const next = { hostId, client_id, subject, email }
    // Revoke local access immediately even if disk persistence subsequently fails.
    this.record = next
    await this.store.write(next)
  }
  async signout() {
    this.pending = null
    if (this.refreshing) await this.refreshing.catch(() => {})
    let revoked = !this.record?.refresh_token
    if (!revoked) {
      try {
        const discovery = await this.json(`${ISSUER}/.well-known/openid-configuration`)
        if (discovery.issuer !== ISSUER || new URL(discovery.revocation_endpoint).origin !== ISSUER)
          fail("invalid_discovery")
        const response = await this.request(discovery.revocation_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: this.record.refresh_token,
            token_type_hint: "refresh_token",
            client_id: this.record.client_id,
          }),
        })
        revoked = response.status === 200
      } catch {}
    }
    await this.clearTokens()
    this.blocked = null
    return { ...this.session(), remoteRevocationConfirmed: revoked }
  }
}
