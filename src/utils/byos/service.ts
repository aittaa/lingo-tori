import type { AuthTransport } from "./transport"
import type { AuthVault, Credentials, PendingAuth } from "./vault"
import { z } from "zod"
import {
  challenge,
  ISSUER,
  randomSecret,
  RESOURCE,
  SCOPES,
  TOKEN_URL,
  validateIdToken,
} from "./oidc"
import { createRedirectUri } from "./transport"

export const invokeSchema = z.strictObject({
  model: z.string().min(1).max(256),
  text: z.string().min(1).max(50000),
  instructions: z.string().max(30000).optional(),
})
export type ByosInvocation = z.infer<typeof invokeSchema>
export const sessionSchema = z.object({
  state: z.enum([
    "disconnected",
    "plan-enabled",
    "identity-only",
    "restricted",
    "limit-reached",
    "reconnect-required",
    "temporarily-unavailable",
  ]),
  account: z.object({ subject: z.string(), email: z.string() }).optional(),
})
export type ByosSession = z.infer<typeof sessionSchema>
export const modelsSchema = z.object({
  models: z.array(z.object({ slug: z.string(), display_name: z.string() })),
})
export type ByosModels = z.infer<typeof modelsSchema>
export function assertByosSender(
  sender: { id?: string; url?: string },
  extensionId: string,
  optionsUrl?: string,
) {
  if (sender.id !== extensionId) throw new Error("Untrusted BYOS sender")
  if (optionsUrl && sender.url?.split(/[?#]/)[0] !== optionsUrl)
    throw new Error("Open BYOS in extension Settings to manage this connection")
}
export class ByosBridgeError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
  ) {
    super(`BYOS: ${code}`)
  }
}
export const BYOS_UNAVAILABLE_CODE = "browser_only_signin_unavailable"
export interface CallbackSender {
  id?: string
  url?: string
  frameId?: number
  tab?: { id?: number }
}
const tokensSchema = z.object({
  access_token: z.string().min(1).max(32768),
  refresh_token: z.string().min(1).max(32768),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().positive().finite().max(31536000),
  scope: z.string().max(4096),
  id_token: z.string().min(1).max(32768).optional(),
})
function fail(code: string, status = 0): never {
  throw new ByosBridgeError(code, status)
}

/** Experimental extension-only authentication; all credential operations stay in the background. */
export function createByosService(
  vault: AuthVault,
  transport: AuthTransport,
  extensionId: string,
  callbackUrl: string,
  fetcher: typeof fetch = fetch,
  now = Date.now,
) {
  let intent = 0
  let starting = false
  let refreshing: Promise<void> | undefined
  let initialization: Promise<void> | undefined
  const controllers = new Set<AbortController>()
  const abortAll = () => {
    for (const controller of controllers) controller.abort()
    controllers.clear()
  }
  async function clearPending(advanceGeneration: boolean, expectedIntent?: number) {
    const pending = await vault.update((record) => {
      if (expectedIntent !== undefined && expectedIntent !== intent) fail("session_changed")
      const previous = record.pending
      if (advanceGeneration) {
        record.generation++
        if (record.refreshing) {
          delete record.refreshing
          delete record.credentials
          record.blocked = "reconnect-required"
          record.tokenVersion++
        }
      }
      delete record.pending
      return previous
    })
    abortAll()
    await transport.cleanup(pending?.tabId)
  }
  async function initialize() {
    const attempt = (initialization ??= (async () => {
      const record = await vault.read()
      if (record.refreshing) {
        // Rotation may have happened before the worker stopped; never replay that token.
        await vault.update((current) => {
          current.generation++
          current.tokenVersion++
          delete current.credentials
          delete current.refreshing
          current.blocked = "reconnect-required"
        })
      }
      if (record.pending?.claimed || (record.pending && record.pending.expires <= now()))
        await clearPending(true)
      else if (!(await transport.reconcile(record.pending)) && record.pending)
        await clearPending(true)
    })())
    try {
      await attempt
    } catch (error) {
      // Other callers can still be unwinding this attempt after an explicit retry
      // starts. Never clear that newer initialization promise.
      if (initialization === attempt) initialization = undefined
      throw error
    }
  }
  async function request(url: string, options: RequestInit = {}) {
    const parsed = new URL(url)
    if (
      parsed.protocol !== "https:" ||
      ![ISSUER, "https://api.openai.com"].includes(parsed.origin) ||
      parsed.username ||
      parsed.password
    )
      fail("invalid_upstream")
    const controller = new AbortController()
    controllers.add(controller)
    try {
      return await fetcher(parsed.href, {
        ...options,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(60000),
          ...(options.signal ? [options.signal] : []),
        ]),
      })
    } catch {
      options.signal?.throwIfAborted()
      return fail("upstream_unavailable")
    } finally {
      controllers.delete(controller)
    }
  }
  async function json(url: string, options: RequestInit = {}) {
    const response = await request(url, options)
    if (!response.ok)
      fail(
        response.status === 429
          ? "usage_limit"
          : response.status === 403
            ? "restricted"
            : "upstream_failure",
        response.status,
      )
    try {
      return (await response.json()) as unknown
    } catch {
      return fail("invalid_upstream_response")
    }
  }
  async function ensureGeneration(generation: number) {
    if ((await vault.read()).generation !== generation) fail("session_changed")
  }
  const parseTokens = (body: unknown) => {
    const parsed = tokensSchema.safeParse(body)
    if (!parsed.success) return fail("invalid_token_response")
    return parsed.data
  }
  async function verifiedIdentity(
    idToken: string,
    clientId: string,
    nonce: string,
    signal: AbortSignal,
    guard: () => Promise<void>,
  ) {
    await guard()
    const discovery = z
      .object({ issuer: z.string(), jwks_uri: z.string() })
      .parse(await json(`${ISSUER}/.well-known/openid-configuration`, { signal }))
    const jwksUrl = new URL(discovery.jwks_uri)
    if (
      discovery.issuer !== ISSUER ||
      jwksUrl.origin !== ISSUER ||
      jwksUrl.username ||
      jwksUrl.password ||
      jwksUrl.hash
    )
      fail("invalid_discovery")
    await guard()
    return validateIdToken(
      idToken,
      await json(jwksUrl.href, { signal }),
      clientId,
      nonce,
      now() / 1000,
    )
  }
  async function refresh() {
    if (refreshing) return refreshing
    refreshing = (async () => {
      const previous = await vault.update((record) => {
        if (!record.credentials || record.refreshing) return fail("reconnect-required")
        record.refreshing = true
        return {
          credentials: record.credentials,
          generation: record.generation,
          version: record.tokenVersion,
        }
      })
      const refreshController = new AbortController()
      controllers.add(refreshController)
      try {
        await ensureGeneration(previous.generation)
        refreshController.signal.throwIfAborted()
        const tokens = parseTokens(
          await json(TOKEN_URL, {
            signal: refreshController.signal,
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: previous.credentials.clientId,
              refresh_token: previous.credentials.refreshToken,
              resource: RESOURCE,
            }),
          }),
        )
        // A rotated response does not establish a new identity. Optional ID tokens are
        // not retained or used to replace the identity validated during sign-in.
        await vault.update((record) => {
          if (
            record.generation !== previous.generation ||
            record.tokenVersion !== previous.version ||
            !record.refreshing
          )
            fail("session_changed")
          record.credentials = {
            ...previous.credentials,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            scopes: tokens.scope.split(/\s+/).filter(Boolean),
            expires: now() + tokens.expires_in * 1000,
          }
          record.tokenVersion++
          delete record.refreshing
          delete record.blocked
        })
      } catch (error) {
        await vault.update((record) => {
          if (
            record.generation === previous.generation &&
            record.tokenVersion === previous.version
          ) {
            record.generation++
            record.tokenVersion++
            delete record.credentials
            delete record.refreshing
            record.blocked = "reconnect-required"
          }
        })
        throw error
      } finally {
        controllers.delete(refreshController)
      }
    })().finally(() => {
      refreshing = undefined
    })
    return refreshing
  }
  async function access() {
    await initialize()
    let record = await vault.read()
    if (record.blocked) fail(record.blocked)
    if (
      !record.credentials?.scopes.includes("chatgpt.tokens.use.direct") ||
      !record.credentials.scopes.includes("resource.invoke")
    )
      fail("plan_permission_required")
    if (record.credentials.expires <= now() + 60000) {
      await refresh()
      record = await vault.read()
    }
    if (
      !record.credentials?.scopes.includes("chatgpt.tokens.use.direct") ||
      !record.credentials.scopes.includes("resource.invoke")
    )
      fail("plan_permission_required")
    return { token: record.credentials.accessToken, generation: record.generation }
  }
  async function authenticated(url: string, options: RequestInit = {}) {
    let active = await access()
    const send = async () => {
      await ensureGeneration(active.generation)
      const headers = new Headers(options.headers)
      headers.set("Authorization", `Bearer ${active.token}`)
      return request(url, { ...options, headers })
    }
    let response = await send()
    await ensureGeneration(active.generation)
    if (response.status === 401) {
      await response.body?.cancel()
      if ((await vault.read()).credentials?.accessToken === active.token) await refresh()
      active = await access()
      response = await send()
      await ensureGeneration(active.generation)
    }
    if (!response.ok) {
      const state =
        response.status === 401
          ? "reconnect-required"
          : response.status === 403
            ? "restricted"
            : response.status === 429
              ? "limit-reached"
              : undefined
      if (state)
        await vault.update((record) => {
          if (record.generation === active.generation) record.blocked = state
        })
      fail(state ?? "upstream_failure", response.status)
    }
    return { response, generation: active.generation }
  }
  return {
    initialize,
    async status() {
      await initialize()
      return { available: await transport.available(), reason: BYOS_UNAVAILABLE_CODE }
    },
    async session(): Promise<ByosSession> {
      await initialize()
      const record = await vault.read()
      return {
        state:
          record.blocked ??
          (record.credentials
            ? record.credentials.scopes.includes("chatgpt.tokens.use.direct") &&
              record.credentials.scopes.includes("resource.invoke")
              ? "plan-enabled"
              : "identity-only"
            : "disconnected"),
        ...(record.credentials
          ? { account: { subject: record.credentials.subject, email: record.credentials.email } }
          : {}),
      }
    },
    async authStart() {
      if (starting) fail("auth_in_progress")
      starting = true
      const ownIntent = ++intent
      try {
        await initialize()
        if (!(await transport.available())) fail(BYOS_UNAVAILABLE_CODE)
        if (ownIntent !== intent) fail("session_changed")
        await clearPending(true, ownIntent)
        abortAll()
        if (ownIntent !== intent) fail("session_changed")
        const record = await vault.read()
        const tabId = await transport.createTab()
        const pending: PendingAuth = {
          state: randomSecret(),
          nonce: randomSecret(),
          verifier: randomSecret(),
          redirectUri: createRedirectUri(),
          tabId,
          expires: now() + 300000,
          generation: record.generation,
          clientId: record.registration?.clientId ?? record.credentials?.clientId,
          subject: record.registration?.subject ?? record.credentials?.subject,
        }
        try {
          await vault.update((current) => {
            if (ownIntent !== intent || current.generation !== pending.generation)
              fail("session_changed")
            current.pending = pending
          })
          await transport.install(pending)
          await ensureGeneration(pending.generation)
          const url = new URL(`${ISSUER}/api/accounts/authorize`)
          url.search = new URLSearchParams({
            client_id: pending.clientId ?? "dynamic_agent_client",
            ext_agent_host_id: record.hostId,
            response_type: "code",
            redirect_uri: pending.redirectUri,
            scope: SCOPES,
            resource: RESOURCE,
            state: pending.state,
            nonce: pending.nonce,
            code_challenge_method: "S256",
            code_challenge: await challenge(pending.verifier),
            ...(!pending.clientId ? { agent_name_hint: "LingoTori" } : {}),
          }).toString()
          await ensureGeneration(pending.generation)
          if (ownIntent !== intent) fail("session_changed")
          await transport.navigate(tabId, url.href)
        } catch (error) {
          await vault.update((current) => {
            if (current.pending?.state === pending.state) {
              delete current.pending
              current.generation++
            }
          })
          await transport.cleanup(tabId)
          throw error
        }
      } finally {
        starting = false
      }
    },
    async callback(query: string, sender: CallbackSender) {
      const ownIntent = intent
      await initialize()
      assertByosSender(sender, extensionId)
      const actual = sender.url ? new URL(sender.url) : undefined
      const expected = new URL(callbackUrl)
      // Extension schemes have opaque URL.origin in some JS runtimes; compare
      // their scheme and host directly instead of accepting a shared "null" origin.
      if (
        !actual ||
        actual.protocol !== expected.protocol ||
        actual.hostname !== expected.hostname ||
        actual.port !== expected.port ||
        actual.username ||
        actual.password ||
        actual.pathname !== expected.pathname ||
        sender.frameId !== 0
      )
        fail("untrusted_callback")
      if (typeof query !== "string" || query.length > 16000) fail("invalid_oauth_callback")
      const params = new URLSearchParams(query)
      for (const key of ["state", "code", "client_id", "error"])
        if (params.getAll(key).length > 1) fail("invalid_oauth_callback")
      const pending = await vault.update((record) => {
        const attempt = record.pending
        if (
          !attempt ||
          attempt.claimed ||
          attempt.expires <= now() ||
          attempt.generation !== record.generation ||
          sender.tab?.id !== attempt.tabId ||
          params.get("state") !== attempt.state
        )
          return fail("invalid_oauth_state")
        attempt.claimed = true
        return { ...attempt }
      })
      const callbackController = new AbortController()
      controllers.add(callbackController)
      const guard = async () => {
        callbackController.signal.throwIfAborted()
        if (ownIntent !== intent) fail("session_changed")
        await ensureGeneration(pending.generation)
        callbackController.signal.throwIfAborted()
      }
      try {
        await transport.cleanup()
        await guard()
        if (params.has("error")) fail("consent_denied")
        const clientId = params.get("client_id") ?? pending.clientId
        const code = params.get("code")
        if (
          !clientId ||
          clientId === "dynamic_agent_client" ||
          clientId.length > 256 ||
          (pending.clientId && clientId !== pending.clientId) ||
          !code ||
          code.length > 8192
        )
          fail("invalid_oauth_callback")
        const tokens = parseTokens(
          await json(TOKEN_URL, {
            signal: callbackController.signal,
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              client_id: clientId,
              code,
              code_verifier: pending.verifier,
              redirect_uri: pending.redirectUri,
              resource: RESOURCE,
            }),
          }),
        )
        if (!tokens.id_token) fail("invalid_id_token")
        const identity = await verifiedIdentity(
          tokens.id_token,
          clientId,
          pending.nonce,
          callbackController.signal,
          guard,
        )
        if (pending.subject && pending.subject !== identity.subject) fail("account_mismatch")
        const credentials: Credentials = {
          clientId,
          ...identity,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          scopes: tokens.scope.split(/\s+/).filter(Boolean),
          expires: now() + tokens.expires_in * 1000,
        }
        await vault.update((record) => {
          if (
            record.generation !== pending.generation ||
            record.pending?.state !== pending.state ||
            !record.pending.claimed
          )
            fail("session_changed")
          record.registration = {
            clientId: credentials.clientId,
            subject: credentials.subject,
            email: credentials.email,
          }
          record.credentials = credentials
          record.tokenVersion++
          delete record.pending
          delete record.blocked
        })
        return this.session()
      } finally {
        controllers.delete(callbackController)
        await vault.update((record) => {
          if (record.pending?.state === pending.state) delete record.pending
        })
      }
    },
    async cancel(tabId?: number) {
      if (tabId === undefined) intent++
      await initialize()
      const record = await vault.read()
      if (tabId !== undefined && record.pending?.tabId !== tabId) return
      if (tabId !== undefined) intent++
      await clearPending(true)
      abortAll()
    },
    async expire() {
      await initialize()
      const record = await vault.read()
      if (record.pending && record.pending.expires <= now()) await this.cancel()
    },
    async models(): Promise<ByosModels> {
      const { response, generation } = await authenticated(`${RESOURCE}/models`)
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return fail("invalid_models")
      }
      const models = z
        .object({
          models: z.array(
            z.object({
              slug: z.string().min(1).max(256),
              display_name: z.string().max(512),
              visibility: z.string(),
            }),
          ),
        })
        .safeParse(body)
      if (!models.success) return fail("invalid_models")
      await ensureGeneration(generation)
      return {
        models: models.data.models
          .filter((model) => model.visibility === "list")
          .map(({ slug, display_name }) => ({ slug, display_name })),
      }
    },
    async signout(): Promise<ByosSession & { remoteRevocationConfirmed: boolean }> {
      intent++
      await initialize()
      // The generation is advanced before network/cleanup so no late response can
      // restore local access. Remote revocation is not claimed without confirmation.
      const pending = await vault.update((record) => {
        record.generation++
        record.tokenVersion++
        const previous = record.pending
        delete record.pending
        delete record.credentials
        delete record.refreshing
        delete record.blocked
        return previous
      })
      abortAll()
      await transport.cleanup(pending?.tabId)
      return { state: "disconnected", remoteRevocationConfirmed: false }
    },
    async invoke(payload: ByosInvocation, signal?: AbortSignal): Promise<{ text: string }> {
      signal?.throwIfAborted()
      const input = invokeSchema.parse(payload)
      const streamController = new AbortController()
      controllers.add(streamController)
      try {
        const { response, generation } = await authenticated(`${RESOURCE}/responses`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: input.model,
            instructions: input.instructions ?? "Translate the supplied text accurately.",
            input: [{ role: "user", content: input.text }],
            store: false,
            stream: true,
          }),
          signal: AbortSignal.any([streamController.signal, ...(signal ? [signal] : [])]),
        })
        if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body)
          fail("invalid_stream")
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = "",
          text = "",
          bytes = 0,
          completed = false
        const consume = (block: string) => {
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
          if (!data || data === "[DONE]") return
          let event: { type?: string; delta?: string; response?: { status?: string } }
          try {
            event = JSON.parse(data)
          } catch {
            fail("invalid_stream")
          }
          if (!event || typeof event.type !== "string" || completed) fail("invalid_stream")
          if (["response.failed", "response.incomplete", "error"].includes(event.type))
            fail("inference_failed")
          if (event.type === "response.output_text.delta") {
            if (typeof event.delta !== "string") fail("invalid_stream")
            text += event.delta
          }
          if (event.type === "response.completed") {
            if (event.response?.status !== "completed") fail("inference_incomplete")
            completed = true
          }
        }
        try {
          while (true) {
            signal?.throwIfAborted()
            await ensureGeneration(generation)
            const chunk = await reader.read()
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > 4000000) fail("response_too_large")
            buffer += decoder.decode(chunk.value, { stream: true })
            buffer = buffer.replace(/\r\n/g, "\n")
            let boundary: number
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              consume(buffer.slice(0, boundary))
              buffer = buffer.slice(boundary + 2)
            }
          }
          buffer += decoder.decode()
          if (buffer.trim()) consume(buffer)
          if (!completed) fail("inference_incomplete")
          await ensureGeneration(generation)
          signal?.throwIfAborted()
          return { text }
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      } finally {
        controllers.delete(streamController)
      }
    },
  }
}
