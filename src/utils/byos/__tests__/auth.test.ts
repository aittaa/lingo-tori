import { describe, expect, it, vi } from "vitest"
import { ISSUER, RESOURCE, SCOPES, TOKEN_URL, validateIdToken } from "../oidc"
import { assertByosSender, createByosService } from "../service"
import { buildCallbackRule, callbackRegex } from "../transport"
import {
  callbackUrl,
  fetchUrl,
  credentials,
  memoryVault,
  mockTransport,
  sender,
  signedFixture,
  signer,
} from "./auth-fixtures"

describe("experimental browser-only sign-in", () => {
  it("installs tab-scoped routing before authorization and stores secrets only in the private vault", async () => {
    const fixture = await signedFixture()
    const { transport, vault, service, query, fetcher } = fixture
    const pending = (await vault.read()).pending!
    expect(transport.install).toHaveBeenCalledWith(pending)
    expect(vi.mocked(transport.install).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(transport.navigate).mock.invocationCallOrder[0]!,
    )
    const url = new URL(vi.mocked(transport.navigate).mock.calls[0]![1])
    expect(url.origin).toBe(ISSUER)
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client")
    expect(url.searchParams.get("redirect_uri")).toBe(pending.redirectUri)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).not.toBe(pending.verifier)
    expect(pending.state).not.toBe(pending.nonce)
    expect(fetcher).not.toHaveBeenCalled()
    expect(await service.callback(query, sender)).toEqual({
      state: "plan-enabled",
      account: { subject: "synthetic-subject", email: "person@example.test" },
    })
    expect((await vault.read()).pending).toBeUndefined()
    expect(JSON.stringify(await service.session())).not.toContain("synthetic-access")
    expect(JSON.stringify(await service.status())).not.toContain("synthetic-refresh")
    const exchange = fetcher.mock.calls[0]![1]!
    expect((exchange.body as URLSearchParams).get("client_id")).toBe("synthetic-client")
    expect((exchange.body as URLSearchParams).get("redirect_uri")).toBe(pending.redirectUri)
    expect(exchange).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" })
    await expect(service.callback(query, sender)).rejects.toThrow("invalid_oauth_state")
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it("checks exact callback sender/path/frame/tab/state and duplicate keys before any exchange", async () => {
    const { service, query, fetcher, vault } = await signedFixture()
    for (const changed of [
      { ...sender, id: "foreign" },
      { ...sender, url: "https://site.example/byos-callback.html" },
      { ...sender, url: `${callbackUrl}/extra` },
      { ...sender, frameId: 1 },
      { ...sender, tab: { id: 41 } },
    ])
      await expect(service.callback(query, changed)).rejects.toThrow(/./)
    for (const changed of [
      query.replace(/state=[^&]+/, "state=wrong"),
      `${query}&state=duplicate`,
      `${query}&code=duplicate`,
      `${query}&client_id=duplicate`,
      `${query}&error=one&error=two`,
    ])
      await expect(service.callback(changed, sender)).rejects.toThrow(/./)
    expect(fetcher).not.toHaveBeenCalled()
    expect((await vault.read()).pending?.claimed).toBeUndefined()
    await vault.update((record) => {
      record.pending!.expires = 1
    })
    await expect(service.callback(query, sender)).rejects.toThrow("invalid_oauth_state")
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("fails closed on denied capability or routing install failure without navigating", async () => {
    for (const denied of [true, false]) {
      const vault = memoryVault(),
        transport = mockTransport(),
        fetcher = vi.fn<typeof fetch>()
      if (denied) vi.mocked(transport.available).mockResolvedValue(false)
      else vi.mocked(transport.install).mockRejectedValue(new Error("install failed"))
      const service = createByosService(vault, transport, "extension", callbackUrl, fetcher)
      await expect(service.authStart()).rejects.toThrow(/./)
      expect(transport.navigate).not.toHaveBeenCalled()
      expect(fetcher).not.toHaveBeenCalled()
      expect((await vault.read()).pending).toBeUndefined()
    }
  })
  it("requires plan scopes and never falls back to another provider", async () => {
    const { service, query, fetcher } = await signedFixture("openid profile email")
    expect((await service.callback(query, sender)).state).toBe("identity-only")
    await expect(service.models()).rejects.toThrow("plan_permission_required")
    await expect(service.invoke({ model: "historical", text: "private" })).rejects.toThrow(
      "plan_permission_required",
    )
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it("logout blocks a late token exchange from restoring credentials", async () => {
    const { service, query, vault, fetcher } = await signedFixture()
    const original = fetcher.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fetcher.mockImplementation(async (input, options) => {
      if (fetchUrl(input) === TOKEN_URL) await gate
      return original(input, options)
    })
    const login = service.callback(query, sender)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    await service.signout()
    release()
    await expect(login).rejects.toThrow(/./)
    expect((await vault.read()).credentials).toBeUndefined()
    expect((await service.session()).state).toBe("disconnected")
  })
  it("reconciles persisted pending attempts and rejects claimed replay after restart", async () => {
    const { service, vault, transport, query, fetcher } = await signedFixture()
    const resumed = createByosService(vault, transport, "extension", callbackUrl, fetcher)
    await resumed.initialize()
    expect(transport.reconcile).toHaveBeenCalledWith((await vault.read()).pending)
    await vault.update((record) => {
      record.pending!.claimed = true
    })
    const restarted = createByosService(vault, transport, "extension", callbackUrl, fetcher)
    await expect(restarted.callback(query, sender)).rejects.toThrow("invalid_oauth_state")
    expect(fetcher).not.toHaveBeenCalled()
    expect((await vault.read()).pending).toBeUndefined()
    await service.signout()
  })
})

it("retains returning registration on logout and rejects changed client and identity", async () => {
  const { service, query, vault, transport, fetcher, keys } = await signedFixture()
  await service.callback(query, sender)
  await service.signout()
  expect((await vault.read()).registration?.clientId).toBe("synthetic-client")
  await service.authStart()
  const returningUrl = new URL(vi.mocked(transport.navigate).mock.calls.at(-1)![1])
  expect(returningUrl.searchParams.get("client_id")).toBe("synthetic-client")
  const state = (await vault.read()).pending!.state
  fetcher.mockClear()
  await expect(
    service.callback(`?state=${state}&code=synthetic-code&client_id=changed-client`, sender),
  ).rejects.toThrow("invalid_oauth_callback")
  expect(fetcher).not.toHaveBeenCalled()
  await service.authStart()
  const pending = (await vault.read()).pending!
  const wrongIdentity = await keys.sign({
    iss: ISSUER,
    aud: "synthetic-client",
    nonce: pending.nonce,
    exp: Date.now() / 1000 + 3600,
    sub: "changed-subject",
  })
  fetcher.mockResolvedValueOnce(
    Response.json({
      access_token: "synthetic-new",
      refresh_token: "synthetic-new-refresh",
      token_type: "Bearer",
      expires_in: 3600,
      scope: SCOPES,
      id_token: wrongIdentity,
    }),
  )
  await expect(
    service.callback(`?state=${pending.state}&code=synthetic-code`, sender),
  ).rejects.toThrow("account_mismatch")
  expect((await vault.read()).credentials).toBeUndefined()
  expect((await vault.read()).registration?.subject).toBe("synthetic-subject")
})
it("logout cancels sign-in intent while callback capability is still pending", async () => {
  const vault = memoryVault(),
    transport = mockTransport(),
    fetcher = vi.fn<typeof fetch>()
  let release!: (value: boolean) => void
  vi.mocked(transport.available).mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve
    }),
  )
  const service = createByosService(vault, transport, "extension", callbackUrl, fetcher)
  const login = service.authStart()
  await vi.waitFor(() => expect(transport.available).toHaveBeenCalledOnce())
  await service.signout()
  release(true)
  await expect(login).rejects.toThrow("session_changed")
  expect(transport.createTab).not.toHaveBeenCalled()
  expect(transport.navigate).not.toHaveBeenCalled()
  expect(fetcher).not.toHaveBeenCalled()
})

describe("OIDC signature and identity validation", () => {
  it("verifies signed claims and rejects nonce/audience/issuer/expiry/algorithm/tampering", async () => {
    const keys = await signer(),
      now = Date.now() / 1000
    const claims = {
      iss: ISSUER,
      aud: "synthetic-client",
      nonce: "synthetic-nonce",
      exp: now + 3600,
      sub: "synthetic-subject",
    }
    const valid = await keys.sign(claims)
    expect(
      await validateIdToken(valid, keys.jwks, "synthetic-client", "synthetic-nonce", now),
    ).toEqual({ subject: "synthetic-subject", email: "" })
    for (const changed of [
      { ...claims, nonce: "wrong" },
      { ...claims, aud: "wrong" },
      { ...claims, iss: "https://evil.example" },
      { ...claims, exp: now - 1 },
      { ...claims, sub: "" },
      { ...claims, aud: ["synthetic-client", "other"] },
    ])
      await expect(
        validateIdToken(
          await keys.sign(changed),
          keys.jwks,
          "synthetic-client",
          "synthetic-nonce",
          now,
        ),
      ).rejects.toThrow("invalid_id_token")
    await expect(
      validateIdToken(
        await keys.sign(claims, { alg: "none", kid: "synthetic-key" }),
        keys.jwks,
        "synthetic-client",
        "synthetic-nonce",
        now,
      ),
    ).rejects.toThrow("invalid_id_token")
    await expect(
      validateIdToken(
        valid.slice(0, -4) + "AAAA",
        keys.jwks,
        "synthetic-client",
        "synthetic-nonce",
        now,
      ),
    ).rejects.toThrow("invalid_id_token")
  })
})

describe("refresh, logout and inference boundaries", () => {
  it("serializes rotating refresh and rejects late refresh after logout", async () => {
    const vault = memoryVault(),
      transport = mockTransport()
    await vault.update((record) => {
      record.credentials = { ...credentials(), expires: 1 }
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (fetchUrl(url) === TOKEN_URL) {
        await gate
        return Response.json({
          access_token: "synthetic-rotated",
          refresh_token: "synthetic-rotated-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: SCOPES,
        })
      }
      return Response.json({ models: [] })
    })
    const service = createByosService(vault, transport, "extension", callbackUrl, fetcher)
    const one = service.models(),
      two = service.models()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    await service.signout()
    release()
    await expect(one).rejects.toThrow("session_changed")
    await expect(two).rejects.toThrow("session_changed")
    expect((await vault.read()).credentials).toBeUndefined()
  })
  it("forces reconnect after an interrupted durable refresh without reusing its token", async () => {
    const vault = memoryVault(),
      transport = mockTransport(),
      fetcher = vi.fn<typeof fetch>()
    await vault.update((record) => {
      record.credentials = credentials()
      record.refreshing = true
    })
    const service = createByosService(vault, transport, "extension", callbackUrl, fetcher)
    expect((await service.session()).state).toBe("reconnect-required")
    await expect(service.models()).rejects.toThrow("reconnect-required")
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("uses only official Responses, requires completed SSE, redacts failures and preserves cancellation", async () => {
    const vault = memoryVault(),
      transport = mockTransport()
    await vault.update((record) => {
      record.credentials = credentials()
    })
    const fetcher = vi.fn<typeof fetch>(async (url, options) => {
      expect(fetchUrl(url)).toBe(`${RESOURCE}/responses`)
      expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer synthetic-access")
      expect(JSON.parse(options?.body as string)).toMatchObject({ store: false, stream: true })
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"Translated"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      )
    })
    const service = createByosService(vault, transport, "extension", callbackUrl, fetcher)
    expect(await service.invoke({ model: "synthetic-model", text: "source" })).toEqual({
      text: "Translated",
    })
    fetcher.mockResolvedValue(
      new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    )
    await expect(service.invoke({ model: "synthetic-model", text: "source" })).rejects.toThrow(
      "inference_incomplete",
    )
    fetcher.mockResolvedValue(
      Response.json({ error: { message: "synthetic-secret" } }, { status: 403 }),
    )
    await expect(service.invoke({ model: "synthetic-model", text: "source" })).rejects.toThrow(
      "restricted",
    )
    const controller = new AbortController()
    controller.abort()
    fetcher.mockClear()
    await expect(
      service.invoke({ model: "synthetic-model", text: "source" }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("rejects a delayed model discovery after logout", async () => {
    const vault = memoryVault(),
      transport = mockTransport()
    await vault.update((record) => {
      record.credentials = credentials()
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetcher = vi.fn<typeof fetch>(async () => {
      await gate
      return Response.json({ models: [] })
    })
    const service = createByosService(vault, transport, "extension", callbackUrl, fetcher)
    const discovery = service.models()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    await service.signout()
    release()
    await expect(discovery).rejects.toThrow("session_changed")
  })
})

it("builds an exact tab-scoped GET redirect preserving query with no broad route", () => {
  const redirectUri = "http://127.0.0.1:51000/auth/callback"
  const rule = buildCallbackRule(42, callbackUrl, redirectUri)
  expect(rule.condition).toMatchObject({
    tabIds: [42],
    requestMethods: ["get"],
    resourceTypes: ["main_frame"],
    isUrlFilterCaseSensitive: true,
  })
  expect(rule.action.redirect.transform).toEqual({
    scheme: "chrome-extension",
    host: "extension",
    path: "/byos-callback.html",
    port: "",
    username: "",
    password: "",
    fragment: "",
  })
  expect(rule.action.redirect.transform).not.toHaveProperty("query")
  const regex = new RegExp(callbackRegex(redirectUri))
  expect(regex.test(`${redirectUri}?code=synthetic&state=synthetic`)).toBe(true)
  for (const url of [
    redirectUri.replace("51000", "51001") + "?code=x",
    redirectUri + "/extra?code=x",
    "http://evil.example/auth/callback?code=x",
    redirectUri.replace("127.0.0.1", "localhost") + "?code=x",
  ])
    expect(regex.test(url)).toBe(false)
  expect(() => assertByosSender({ id: "foreign" }, "extension")).toThrow("Untrusted")
})

it("does not exchange a callback code after logout during routing cleanup", async () => {
  const { service, transport, query, fetcher } = await signedFixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.mocked(transport.cleanup).mockReturnValueOnce(gate)
  const login = service.callback(query, sender)
  await vi.waitFor(() => expect(transport.cleanup).toHaveBeenCalledTimes(2))
  await service.signout()
  release()
  await expect(login).rejects.toThrow(/./)
  expect(fetcher).not.toHaveBeenCalled()
})
