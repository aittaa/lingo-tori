import { afterEach, describe, expect, it, vi } from "vitest"
import { ByosBridgeError, machineError, responseError } from "../errors"
import { ISSUER, RESOURCE, SCOPES, TOKEN_URL } from "../oidc"
import { createByosService } from "../service"
import { callbackUrl, credentials, fetchUrl, memoryVault, mockTransport } from "./auth-fixtures"

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
const newTokens = () => ({
  access_token: "synthetic-new-access",
  refresh_token: "synthetic-new-refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope: SCOPES,
})
async function prepared(expires: number, clock: () => number = Date.now) {
  const vault = memoryVault(),
    transport = mockTransport()
  await vault.update((record) => {
    record.credentials = { ...credentials(), expires }
    record.registration = {
      clientId: "synthetic-client",
      subject: "synthetic-subject",
      email: "person@example.test",
    }
  })
  return {
    vault,
    transport,
    make: (fetcher: typeof fetch) =>
      createByosService(vault, transport, "extension", callbackUrl, fetcher, clock),
  }
}
const emptyModels = () => Response.json({ models: [] })
const issuerDiscovery = () =>
  Response.json({ issuer: ISSUER, revocation_endpoint: `${ISSUER}/synthetic-revocation` })

it("keeps safe OAuth/API diagnostics while dropping raw messages, details, bodies, and token-like values", async () => {
  const failure = await responseError(
    Response.json(
      {
        error: {
          code: "subscription_sharing_unsupported_capability",
          param: "tools[0].type",
          message: "Bearer synthetic-private-token",
        },
        detail: "synthetic-private-token",
      },
      { status: 400, headers: { "x-request-id": "req_synthetic_diagnostic" } },
    ),
  )
  expect(failure).toBeInstanceOf(ByosBridgeError)
  expect(failure).toMatchObject({
    status: 400,
    code: "subscription_sharing_unsupported_capability",
    param: "tools[0].type",
    requestId: "req_synthetic_diagnostic",
  })
  expect(JSON.stringify(failure)).not.toContain("synthetic-private-token")
  expect(
    machineError({ error: "invalid_grant", error_description: "synthetic-private-token" }, 400),
  ).toMatchObject({ status: 400, code: "invalid_grant" })
  expect(
    machineError(
      {
        error: { code: "synthetic_private_token", param: "Bearer synthetic-private-token" },
        request_id: "Bearer synthetic-private-token",
      },
      503,
    ),
  ).toMatchObject({ code: "upstream_failure", status: 503, param: undefined, requestId: undefined })
  expect(new ByosBridgeError("reconnect-required").message).toContain("reconnect-required")
  expect(new ByosBridgeError("temporarily-unavailable").code).toBe("temporarily-unavailable")
})

describe("refresh lifecycle", () => {
  it("keeps valid access through 503, applies cooldown, and lets an expired session recover after that cooldown", async () => {
    let clock = 1000000,
      refreshes = 0
    const { vault, make } = await prepared(clock + 20000, () => clock)
    const fetcher = vi.fn<typeof fetch>(async (url, options) => {
      if (fetchUrl(url) === TOKEN_URL) {
        refreshes++
        return refreshes === 1
          ? Response.json(
              { error: "server_error" },
              { status: 503, headers: { "x-request-id": "req_refresh_503" } },
            )
          : Response.json(newTokens())
      }
      expect(new Headers(options?.headers).get("Authorization")).toBe(
        refreshes > 1 ? "Bearer synthetic-new-access" : "Bearer synthetic-access",
      )
      return emptyModels()
    })
    const service = make(fetcher)
    expect(await service.models()).toEqual({ models: [] })
    const failed = await vault.read()
    expect(failed.credentials?.refreshToken).toBe("synthetic-refresh")
    expect(failed.refreshRetryAfter).toBe(clock + 1000)
    expect(failed.refreshFailure).toEqual({
      code: "server_error",
      status: 503,
      requestId: "req_refresh_503",
    })
    expect(failed.refreshUncertain).toBeUndefined()
    await service.models()
    expect(refreshes).toBe(1)
    clock = failed.refreshRetryAfter! + 1
    await vault.update((record) => {
      record.credentials!.expires = clock - 1
    })
    // The settings page only discovers models from a plan-enabled session.
    expect((await service.session()).state).toBe("plan-enabled")
    expect(await service.models()).toEqual({ models: [] })
    expect(refreshes).toBe(2)
    expect((await vault.read()).refreshRetryAfter).toBeUndefined()
  })
  it.each([
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
  ])("clears only terminal refresh error %s and keeps registration", async (code) => {
    const { vault, make } = await prepared(1)
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ error: code, error_description: "synthetic-private-token" }, { status: 400 }),
    )
    const service = make(fetcher)
    await expect(service.models()).rejects.toMatchObject({ code, status: 400 })
    const record = await vault.read()
    expect(record.credentials).toBeUndefined()
    expect(record.registration?.clientId).toBe("synthetic-client")
    expect((await service.session()).state).toBe("reconnect-required")
    await expect(service.models()).rejects.toThrow("reconnect-required")
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it("treats invalid_client as configuration failure and retains the token set", async () => {
    const { vault, make } = await prepared(1)
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ error: "invalid_client" }, { status: 400 }),
    )
    const service = make(fetcher)
    await expect(service.models()).rejects.toMatchObject({ code: "invalid_client", status: 400 })
    expect((await vault.read()).credentials?.refreshToken).toBe("synthetic-refresh")
    expect((await vault.read()).refreshConfigurationError).toBe(true)
    await expect(service.models()).rejects.toThrow("invalid_client")
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it.each(["network", "timeout", "body-loss"])(
    "does not replay uncertain rotation after %s and uses valid access only until expiry",
    async (failure) => {
      let clock = 1000000,
        refreshes = 0
      const { vault, make } = await prepared(clock + 20000, () => clock)
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        if (fetchUrl(url) === TOKEN_URL) {
          refreshes++
          if (failure === "network") throw new Error("raw synthetic-private-token diagnostic")
          if (failure === "timeout") throw new DOMException("Timeout", "TimeoutError")
          return new Response("broken token response", { status: 200 })
        }
        return emptyModels()
      })
      const service = make(fetcher)
      expect(await service.models()).toEqual({ models: [] })
      expect((await vault.read()).refreshUncertain).toBe(true)
      expect(JSON.stringify((await vault.read()).refreshFailure)).not.toContain(
        "synthetic-private-token",
      )
      await service.models()
      expect(refreshes).toBe(1)
      clock += 20001
      expect((await service.session()).state).toBe("reconnect-required")
      await expect(service.models()).rejects.toThrow("reconnect-required")
      expect(refreshes).toBe(1)
      expect((await vault.read()).credentials?.refreshToken).toBe("synthetic-refresh")
    },
  )
  it("does not reuse an explicitly rejected access token after an uncertain rotation", async () => {
    const { vault, make } = await prepared(Date.now() + 20000)
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (fetchUrl(url) === TOKEN_URL) throw new Error("synthetic lost token response")
      return Response.json({ error: { code: "invalid_token" } }, { status: 401 })
    })
    const service = make(fetcher)
    await expect(service.models()).rejects.toMatchObject({
      code: "reconnect-required",
    })
    expect((await vault.read()).accessRejected).toBe(true)
    await expect(service.models()).rejects.toThrow("reconnect-required")
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect((await vault.read()).credentials?.accessToken).toBe("synthetic-access")
  })
  it("preserves valid access after restart during rotation, then requires reauthorization at expiry", async () => {
    let clock = 1000000
    const { vault, make } = await prepared(clock + 20000, () => clock)
    await vault.update((record) => {
      record.refreshing = true
    })
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      expect(fetchUrl(url)).toBe(`${RESOURCE}/models`)
      return emptyModels()
    })
    const service = make(fetcher)
    expect((await service.session()).state).toBe("plan-enabled")
    await service.models()
    expect((await vault.read()).refreshUncertain).toBe(true)
    expect((await vault.read()).credentials).toBeDefined()
    clock += 20001
    await expect(service.models()).rejects.toThrow("reconnect-required")
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

describe("request-level API failures", () => {
  it.each([
    [403, "subscription_sharing_route_not_supported", "restricted"],
    [429, "subscription_sharing_usage_limit_exceeded", "limit-reached"],
  ] as const)(
    "recovers from %s without poisoning persisted account state",
    async (status, code, legacy) => {
      const { vault, make } = await prepared(Date.now() + 3600000)
      await vault.update((record) => {
        record.blocked = legacy
      })
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json(
            { error: { code, param: "model", message: "synthetic-private-token" } },
            { status, headers: { "x-request-id": "req_api_failure" } },
          ),
        )
        .mockResolvedValueOnce(emptyModels())
      const service = make(fetcher)
      await expect(service.models()).rejects.toMatchObject({
        status,
        code,
        param: "model",
        requestId: "req_api_failure",
      })
      expect((await vault.read()).blocked).toBeUndefined()
      expect((await service.session()).state).toBe("plan-enabled")
      expect(await service.models()).toEqual({ models: [] })
      expect(fetcher).toHaveBeenCalledTimes(2)
    },
  )
  it.each(["error", "response.failed"])(
    "parses machine diagnostics from SSE %s without changing credentials",
    async (type) => {
      const { vault, make } = await prepared(Date.now() + 3600000)
      const error = {
        code: "subscription_sharing_unsupported_capability",
        param: "tools[0].type",
        message: "synthetic-private-token",
      }
      const event =
        type === "error" ? { type, error } : { type, response: { status: "failed", error } }
      const fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response(`data: ${JSON.stringify(event)}\n\n`, {
            headers: { "content-type": "text/event-stream", "x-request-id": "req_sse_failure" },
          }),
      )
      const service = make(fetcher)
      await expect(
        service.invoke({ model: "synthetic-model", text: "source" }),
      ).rejects.toMatchObject({
        status: 200,
        code: error.code,
        param: error.param,
        requestId: "req_sse_failure",
      })
      expect((await vault.read()).credentials).toBeDefined()
      expect((await vault.read()).blocked).toBeUndefined()
    },
  )
})

describe("renewable-session sign-out", () => {
  it("invalidates local access first, revokes only the discovered issuer endpoint and confirms only HTTP200", async () => {
    const { vault, make } = await prepared(Date.now() + 3600000)
    const fetcher = vi.fn<typeof fetch>(async (url, options) => {
      expect((await vault.read()).credentials).toBeUndefined()
      expect((await vault.read()).generation).toBe(1)
      if (fetchUrl(url) === `${ISSUER}/.well-known/openid-configuration`) return issuerDiscovery()
      expect(fetchUrl(url)).toBe(`${ISSUER}/synthetic-revocation`)
      expect(options).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" })
      expect(Object.fromEntries(options!.body as URLSearchParams)).toEqual({
        token: "synthetic-refresh",
        token_type_hint: "refresh_token",
        client_id: "synthetic-client",
      })
      return new Response(null, { status: 200 })
    })
    const service = make(fetcher)
    expect(await service.signout()).toEqual({
      state: "disconnected",
      authPending: false,
      remoteRevocationConfirmed: true,
    })
    expect((await vault.read()).registration?.clientId).toBe("synthetic-client")
    expect(fetcher).toHaveBeenCalledTimes(2)
    await expect(service.models()).rejects.toThrow("plan_permission_required")
  })
  it.each([
    "https://evil.example/revoke",
    `${ISSUER}/revoke?token=leak`,
    `${ISSUER}/revoke#fragment`,
    "https://user:password@auth.openai.com/revoke",
    "http://auth.openai.com/revoke",
  ])("rejects untrusted revocation endpoint %s without sending a token", async (endpoint) => {
    const { vault, make } = await prepared(Date.now() + 3600000)
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ issuer: ISSUER, revocation_endpoint: endpoint }),
    )
    const service = make(fetcher)
    expect((await service.signout()).remoteRevocationConfirmed).toBe(false)
    expect(fetcher).toHaveBeenCalledOnce()
    expect((await vault.read()).credentials).toBeUndefined()
  })
  it("retries network/5xx with bounded backoff and never confirms an HTTP204", async () => {
    vi.useFakeTimers()
    const { make } = await prepared(Date.now() + 3600000)
    let posts = 0
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      fetchUrl(url).endsWith("openid-configuration")
        ? issuerDiscovery()
        : ++posts === 1
          ? new Response(null, { status: 503 })
          : new Response(null, { status: 204 }),
    )
    const logout = make(fetcher).signout()
    await vi.advanceTimersByTimeAsync(150)
    expect((await logout).remoteRevocationConfirmed).toBe(false)
    expect(posts).toBe(2)
  })
  it("bounds cleanup, body reads and lost network responses within the shared logout budget", async () => {
    vi.useFakeTimers()
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), milliseconds)
      return controller.signal
    })
    const { vault, transport, make } = await prepared(Date.now() + 3600000)
    vi.mocked(transport.cleanup).mockReturnValue(new Promise<void>(() => {}))
    const fetcher = vi.fn<typeof fetch>(async () => new Promise<Response>(() => {}))
    const start = Date.now(),
      logout = make(fetcher).signout()
    await vi.advanceTimersByTimeAsync(6500)
    expect((await logout).remoteRevocationConfirmed).toBe(false)
    expect(Date.now() - start).toBe(6500)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect((await vault.read()).credentials).toBeUndefined()
  })
})

it("reports only a safe pending flag through claims and cancellation", async () => {
  const vault = memoryVault(),
    transport = mockTransport(),
    fetcher = vi.fn<typeof fetch>()
  const service = createByosService(vault, transport, "extension", callbackUrl, fetcher)
  await service.authStart()
  expect(await service.session()).toEqual({ state: "disconnected", authPending: true })
  await vault.update((record) => {
    record.pending!.claimed = true
  })
  expect((await service.session()).authPending).toBe(true)
  await service.cancel(42)
  expect(await service.session()).toEqual({ state: "disconnected", authPending: false })
  expect(fetcher).not.toHaveBeenCalled()
})
it("bounds a stalled discovery body read and clears local access without a revocation claim", async () => {
  vi.useFakeTimers()
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), milliseconds)
    return controller.signal
  })
  const { vault, make } = await prepared(Date.now() + 3600000)
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(new ReadableStream<Uint8Array>({ start() {} })),
  )
  const start = Date.now(),
    logout = make(fetcher).signout()
  await vi.advanceTimersByTimeAsync(2000)
  expect((await logout).remoteRevocationConfirmed).toBe(false)
  expect(Date.now() - start).toBe(2000)
  expect(fetcher).toHaveBeenCalledOnce()
  expect((await vault.read()).credentials).toBeUndefined()
})
