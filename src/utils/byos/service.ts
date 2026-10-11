import type { AuthTransport } from "./transport"
import type { AuthVault, Credentials, PendingAuth, VaultRecord } from "./vault"
import { z } from "zod"
import {
  abortable,
  ByosBridgeError,
  failureDetails,
  machineError,
  responseError,
  TERMINAL_REFRESH_CODES,
} from "./errors"
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
  authPending: z.boolean().optional(),
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
export { ByosBridgeError } from "./errors"
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

function hasPlanAccess(credentials: Credentials | undefined): credentials is Credentials {
  return (
    !!credentials?.scopes.includes("chatgpt.tokens.use.direct") &&
    credentials.scopes.includes("resource.invoke")
  )
}
function clearRefreshState(record: VaultRecord) {
  delete record.accessRejected
  delete record.refreshing
  delete record.refreshUncertain
  delete record.refreshConfigurationError
  delete record.refreshRetryAfter
  delete record.refreshFailures
  delete record.refreshFailure
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
  let signingOut: Promise<ByosSession & { remoteRevocationConfirmed: boolean }> | undefined
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
          record.refreshUncertain = true
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
      if (
        record.refreshing ||
        record.blocked === "restricted" ||
        record.blocked === "limit-reached" ||
        record.blocked === "temporarily-unavailable" ||
        (record.blocked === "reconnect-required" && record.credentials)
      ) {
        await vault.update((current) => {
          if (current.refreshing) {
            current.generation++
            current.tokenVersion++
            current.refreshUncertain = true
            delete current.refreshing
          }
          if (current.blocked === "reconnect-required" && current.credentials) {
            current.refreshUncertain = true
            current.accessRejected = true
          }
          if (current.blocked !== "reconnect-required" || current.credentials)
            delete current.blocked
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
      if (initialization === attempt) initialization = undefined
      throw error
    }
  }
  async function request(
    url: string,
    options: RequestInit = {},
    timeoutMs = 60000,
    revoking = false,
  ) {
    if (signingOut && !revoking) fail("session_changed")
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
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(timeoutMs),
      ...(options.signal ? [options.signal] : []),
    ])
    try {
      return await abortable(
        fetcher(parsed.href, {
          ...options,
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          signal,
        }),
        signal,
      )
    } catch (error) {
      const timedOut =
        (signal.reason instanceof DOMException && signal.reason.name === "TimeoutError") ||
        (error instanceof DOMException && error.name === "TimeoutError")
      if (controller.signal.aborted && !timedOut) fail("session_changed")
      if (options.signal?.aborted && !timedOut)
        throw new DOMException("The operation was aborted", "AbortError")
      return fail(timedOut ? "upstream_timeout" : "upstream_unavailable")
    } finally {
      controllers.delete(controller)
    }
  }
  async function json(url: string, options: RequestInit = {}, timeoutMs = 60000, revoking = false) {
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(options.signal ? [options.signal] : []),
    ])
    const response = await request(url, { ...options, signal }, timeoutMs, revoking)
    if (!response.ok) throw await responseError(response, signal)
    try {
      return await abortable(response.json() as Promise<unknown>, signal)
    } catch {
      return fail("invalid_upstream_response", response.status)
    }
  }
  async function ensureGeneration(generation: number) {
    if (signingOut || (await vault.read()).generation !== generation) fail("session_changed")
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
        if (!record.credentials || record.refreshUncertain || record.refreshing)
          return fail("reconnect-required")
        if (record.refreshConfigurationError) throw new ByosBridgeError("invalid_client")
        if ((record.refreshRetryAfter ?? 0) > now())
          throw new ByosBridgeError("refresh_retry_later")
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
        await vault.update((record) => {
          if (
            signingOut ||
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
          clearRefreshState(record)
          delete record.blocked
        })
      } catch (error) {
        const failure =
          error instanceof ByosBridgeError ? error : new ByosBridgeError("upstream_unavailable")
        await vault.update((record) => {
          if (record.generation !== previous.generation || record.tokenVersion !== previous.version)
            return
          delete record.refreshing
          record.refreshFailure = failureDetails(failure)
          if (TERMINAL_REFRESH_CODES.has(failure.code)) {
            record.generation++
            record.tokenVersion++
            delete record.credentials
            clearRefreshState(record)
            record.blocked = "reconnect-required"
          } else if (
            failure.status === 0 ||
            failure.code === "invalid_upstream_response" ||
            failure.code === "invalid_token_response"
          ) {
            record.refreshUncertain = true
          } else if (failure.code === "invalid_client") {
            record.refreshConfigurationError = true
          } else {
            record.refreshFailures = Math.min((record.refreshFailures ?? 0) + 1, 6)
            record.refreshRetryAfter =
              now() + Math.min(1000 * 2 ** (record.refreshFailures - 1), 30000)
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
    if (signingOut) fail("session_changed")
    if (record.accessRejected)
      fail(record.refreshUncertain ? "reconnect-required" : "authorization_required")
    if (record.blocked === "reconnect-required" && !record.credentials) fail("reconnect-required")
    if (!hasPlanAccess(record.credentials)) fail("plan_permission_required")
    if (record.credentials.expires <= now() + 60000) {
      if (
        !record.refreshUncertain &&
        !record.refreshConfigurationError &&
        (record.refreshRetryAfter ?? 0) <= now()
      ) {
        try {
          await refresh()
        } catch (error) {
          const current = await vault.read()
          if (
            current.generation !== record.generation ||
            current.accessRejected ||
            !hasPlanAccess(current.credentials) ||
            current.credentials.expires <= now()
          )
            throw error
        }
        record = await vault.read()
      }
    }
    if (!hasPlanAccess(record.credentials))
      fail(
        record.blocked === "reconnect-required" ? "reconnect-required" : "plan_permission_required",
      )
    if (record.credentials.expires <= now()) {
      if (record.refreshUncertain) fail("reconnect-required")
      if (record.refreshConfigurationError) throw new ByosBridgeError("invalid_client")
      const failure = record.refreshFailure
      if (failure) throw new ByosBridgeError(failure.code, failure.status, failure)
      fail("refresh_retry_later")
    }
    return {
      token: record.credentials.accessToken,
      generation: record.generation,
      version: record.tokenVersion,
    }
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
    if (!response.ok) {
      const error = await responseError(response, options.signal ?? undefined)
      if (response.status === 401)
        await vault.update((record) => {
          if (
            record.generation === active.generation &&
            record.tokenVersion === active.version &&
            record.credentials?.accessToken === active.token
          )
            record.accessRejected = true
        })
      // Subscriber-context and admission failures are not proof of revocation.
      // Retry once only when the API explicitly identifies an expired token.
      if (response.status === 401 && ["token_expired", "invalid_token"].includes(error.code)) {
        if ((await vault.read()).credentials?.accessToken === active.token) await refresh()
        active = await access()
        response = await send()
        await ensureGeneration(active.generation)
        if (!response.ok) {
          if (response.status === 401)
            await vault.update((record) => {
              if (
                record.generation === active.generation &&
                record.tokenVersion === active.version &&
                record.credentials?.accessToken === active.token
              )
                record.accessRejected = true
            })
          throw await responseError(response, options.signal ?? undefined)
        }
      } else throw error
    }
    return { response, generation: active.generation }
  }
  async function backoff(signal: AbortSignal) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await abortable(
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 150)
        }),
        signal,
      )
    } finally {
      clearTimeout(timer)
    }
  }
  async function retryRevocation<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      try {
        return await operation()
      } catch (error) {
        const retryable =
          error instanceof ByosBridgeError && (error.status === 0 || error.status >= 500)
        if (!retryable || attempt >= 1) throw error
        await backoff(signal)
      }
    }
  }
  async function revokeSession(
    token: string | undefined,
    clientId: string | undefined,
    signal: AbortSignal,
  ) {
    if (!token || !clientId) return false
    try {
      const discovery = await retryRevocation(
        () => json(`${ISSUER}/.well-known/openid-configuration`, { signal }, 2000, true),
        signal,
      )
      const fields = z
        .object({ issuer: z.literal(ISSUER), revocation_endpoint: z.string() })
        .safeParse(discovery)
      if (!fields.success) return false
      const endpoint = new URL(fields.data.revocation_endpoint)
      if (
        endpoint.protocol !== "https:" ||
        endpoint.origin !== ISSUER ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      )
        return false
      const response = await retryRevocation(async () => {
        const result = await request(
          endpoint.href,
          {
            signal,
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token,
              token_type_hint: "refresh_token",
              client_id: clientId,
            }),
          },
          2000,
          true,
        )
        if (result.status >= 500) throw await responseError(result, signal)
        void result.body?.cancel().catch(() => {})
        return result
      }, signal)
      return response.status === 200
    } catch {
      return false
    }
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
      const expired = !!record.credentials && record.credentials.expires <= now()
      const state: ByosSession["state"] =
        record.blocked === "reconnect-required" && !record.credentials
          ? "reconnect-required"
          : record.accessRejected || (expired && record.refreshUncertain)
            ? "reconnect-required"
            : expired &&
                ((record.refreshRetryAfter ?? 0) > now() || record.refreshConfigurationError)
              ? "temporarily-unavailable"
              : record.credentials
                ? hasPlanAccess(record.credentials)
                  ? "plan-enabled"
                  : "identity-only"
                : "disconnected"
      return {
        state,
        authPending: !!record.pending && record.pending.expires > now(),
        ...(record.credentials
          ? { account: { subject: record.credentials.subject, email: record.credentials.email } }
          : {}),
      }
    },
    async authStart() {
      if (signingOut) fail("signout_in_progress")
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
    async recoverCallbackNavigation(details: {
      url: string
      tabId: number
      frameId: number
      error: string
    }): Promise<boolean> {
      const ownIntent = intent
      if (
        details.error !== "net::ERR_CONNECTION_REFUSED" ||
        details.frameId !== 0 ||
        !Number.isSafeInteger(details.tabId) ||
        details.tabId < 0 ||
        typeof details.url !== "string" ||
        details.url.length > 16100
      )
        return false
      let failed: URL, destination: URL
      try {
        failed = new URL(details.url)
        destination = new URL(callbackUrl)
      } catch {
        return false
      }
      if (
        destination.protocol !== "chrome-extension:" ||
        destination.hostname !== extensionId ||
        !!destination.port ||
        destination.pathname !== "/byos-callback.html" ||
        destination.search ||
        destination.hash ||
        destination.username ||
        destination.password
      )
        return false
      if (
        failed.protocol !== "http:" ||
        failed.hostname !== "127.0.0.1" ||
        failed.pathname !== "/auth/callback" ||
        failed.username ||
        failed.password ||
        failed.hash ||
        failed.search.length > 16000
      )
        return false
      const params = failed.searchParams
      if (params.getAll("state").length !== 1) return false
      for (const key of ["code", "client_id", "error"])
        if (params.getAll(key).length > 1) return false
      if (params.has("code") === params.has("error")) return false
      const code = params.get("code"),
        error = params.get("error"),
        clientId = params.get("client_id")
      if (
        (code !== null && (!code.trim() || code.length > 8192)) ||
        (error !== null && !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(error)) ||
        (clientId !== null && (!clientId.trim() || clientId.length > 256))
      )
        return false
      await initialize()
      if (!(await transport.available())) return false
      const pending = await vault.update((record) => {
        const attempt = record.pending
        if (
          ownIntent !== intent ||
          signingOut ||
          !attempt ||
          attempt.claimed ||
          attempt.relayStarted ||
          attempt.expires <= now() ||
          attempt.generation !== record.generation ||
          attempt.tabId !== details.tabId ||
          params.get("state") !== attempt.state
        )
          return undefined
        // Compare the whole registered loopback origin/path, including the port.
        if (`${failed.origin}${failed.pathname}` !== attempt.redirectUri) return undefined
        attempt.relayStarted = true
        return { ...attempt }
      })
      if (!pending) return false
      const relay = new URLSearchParams()
      for (const key of ["code", "state", "client_id", "error"]) {
        const value = params.get(key)
        if (value !== null) relay.set(key, value)
      }
      destination.search = relay.toString()
      try {
        await ensureGeneration(pending.generation)
        if (ownIntent !== intent || pending.expires <= now()) return false
        // Relay through the actual extension page. Its existing strict sender,
        // state, PKCE and nonce checks still own code exchange and validation.
        await transport.navigate(pending.tabId, destination.href)
        return true
      } catch {
        return false
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
            !!signingOut ||
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
          clearRefreshState(record)
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
      if (signingOut) return signingOut
      intent++
      signingOut = (async () => {
        abortAll()
        // Capture only the token needed to end this renewable session. Local
        // access ends atomically before cleanup, discovery, or any revocation I/O.
        const previous = await vault.update((record) => {
          record.generation++
          record.tokenVersion++
          const snapshot = {
            pending: record.pending,
            token: record.credentials?.refreshToken,
            clientId: record.credentials?.clientId,
          }
          delete record.pending
          delete record.credentials
          delete record.blocked
          clearRefreshState(record)
          return snapshot
        })
        const signal = AbortSignal.timeout(6500)
        const cleanup = abortable(transport.cleanup(previous.pending?.tabId), signal).catch(
          () => {},
        )
        const revocation = revokeSession(previous.token, previous.clientId, signal)
        const [, confirmed] = await Promise.all([cleanup, revocation])
        return {
          state: "disconnected" as const,
          authPending: false,
          remoteRevocationConfirmed: confirmed,
        }
      })().finally(() => {
        signingOut = undefined
      })
      return signingOut
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
          let event: {
            type?: string
            delta?: string
            error?: unknown
            code?: string
            param?: string
            request_id?: string
            response?: { status?: string; error?: unknown }
          }
          try {
            event = JSON.parse(data)
          } catch {
            fail("invalid_stream")
          }
          if (!event || typeof event.type !== "string" || completed) fail("invalid_stream")
          if (["response.failed", "error"].includes(event.type))
            throw machineError(
              {
                error: event.response?.error ?? event.error ?? event,
                request_id: event.request_id,
              },
              response.status,
              response.headers.get("x-request-id"),
            )
          if (event.type === "response.incomplete") fail("inference_incomplete")
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
