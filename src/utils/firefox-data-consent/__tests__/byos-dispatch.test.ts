// The experimental ChatGPT sign-in (BYOS) on a Firefox build. Every request it makes carries or
// establishes a credential: dynamic client registration, the authorization code exchange, token
// refresh, the account's model list and each inference call. Starting a sign-in opens the identity
// provider's login in a tab.
//
// On Firefox none of those starts unless `authenticationInfo` is granted, and the grant is read
// for each new request, so a revocation stops the next one. The refusal comes back as an error
// that says consent is missing; no tab is opened and nothing is sent. A Chrome build is not gated.
//
// These tests drive the real service with a doubled transport, vault and `fetch`, and do not
// import the consent module: on the base commit the sign-in simply proceeds.

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  callbackUrl as chromeCallbackUrl,
  credentials,
  fetchUrl,
  memoryVault,
  mockTransport,
  signedFixture,
} from "@/utils/byos/__tests__/auth-fixtures"
import { ISSUER, RESOURCE, SCOPES, TOKEN_URL } from "@/utils/byos/oidc"
import { createByosService } from "@/utils/byos/service"
import {
  installChrome,
  installFirefox,
  removePermissionsDouble,
  REQUIRED_ONLY,
  WITH_CREDENTIALS,
} from "./firefox-permissions"

const firefoxTarget = {
  extensionId: "lingotori@aittaa",
  callbackUrl: "moz-extension://a702f145-d458-4acf-9101-6549d0c2babc/byos-callback.html",
}
const firefoxSender = {
  id: firefoxTarget.extensionId,
  url: firefoxTarget.callbackUrl,
  frameId: 0,
  tab: { id: 42 },
}

afterEach(() => {
  vi.useRealTimers()
  removePermissionsDouble()
})

const models = () => Response.json({ models: [] })

/** A signed-in service: valid credentials in the vault, an upstream that answers every call. */
async function connected(target = firefoxTarget, expires = Date.now() + 3_600_000) {
  const vault = memoryVault()
  const transport = mockTransport()
  await vault.update((record) => {
    record.credentials = { ...credentials(), expires }
    record.registration = {
      clientId: "synthetic-client",
      subject: "synthetic-subject",
      email: "person@example.test",
    }
  })
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = fetchUrl(input)
    if (url === TOKEN_URL) {
      return Response.json({
        access_token: "synthetic-new-access",
        refresh_token: "synthetic-new-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: SCOPES,
      })
    }
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        revocation_endpoint: `${ISSUER}/synthetic-revocation`,
      })
    }
    if (url === `${ISSUER}/synthetic-revocation`) return new Response(null, { status: 200 })
    if (url === `${RESOURCE}/models`) return models()
    if (url === `${RESOURCE}/responses`) {
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"synthetic result"}\n\n' +
          'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      )
    }
    throw new Error(`Unmocked upstream ${url}`)
  })
  const service = createByosService(
    vault,
    transport,
    target.extensionId,
    target.callbackUrl,
    fetcher,
  )
  return { vault, transport, fetcher, service }
}

describe("Firefox, authenticationInfo not granted (the state after install)", () => {
  it("does not start a sign-in: no tab, no rule, no navigation, no request", async () => {
    installFirefox(REQUIRED_ONLY)
    const vault = memoryVault()
    const transport = mockTransport()
    const fetcher = vi.fn<typeof fetch>()
    const service = createByosService(
      vault,
      transport,
      firefoxTarget.extensionId,
      firefoxTarget.callbackUrl,
      fetcher,
    )

    await expect(service.authStart()).rejects.toThrow(/consent/i)

    expect(transport.createTab).not.toHaveBeenCalled()
    expect(transport.install).not.toHaveBeenCalled()
    expect(transport.navigate).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    expect((await vault.read()).pending).toBeUndefined()
  })

  it("does not list models", async () => {
    installFirefox(REQUIRED_ONLY)
    const { service, fetcher } = await connected()

    await expect(service.models()).rejects.toThrow(/consent/i)

    expect(fetcher).not.toHaveBeenCalled()
  })

  it("does not run an inference request", async () => {
    installFirefox(REQUIRED_ONLY)
    const { service, fetcher } = await connected()

    await expect(service.invoke({ model: "synthetic-model", text: "Hello" })).rejects.toThrow(
      /consent/i,
    )

    expect(fetcher).not.toHaveBeenCalled()
  })

  it("does not refresh an expired token, so the refresh token is not sent", async () => {
    installFirefox(REQUIRED_ONLY)
    const { service, fetcher } = await connected(firefoxTarget, Date.now() - 1000)

    await expect(service.models()).rejects.toThrow(/./)

    expect(fetcher.mock.calls.map(([input]) => fetchUrl(input))).not.toContain(TOKEN_URL)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("does not exchange an authorization code, so the code and verifier are not sent", async () => {
    // The sign-in started while the grant was there; the user revokes before the callback returns.
    const permissions = installFirefox(WITH_CREDENTIALS)
    const { service, fetcher, query } = await signedFixture(SCOPES, firefoxTarget)
    fetcher.mockClear()
    permissions.report(REQUIRED_ONLY)

    await expect(service.callback(query, firefoxSender)).rejects.toThrow(/./)

    expect(fetcher).not.toHaveBeenCalled()
  })

  it("does not send the refresh token to revoke it on sign-out, but ends the session locally", async () => {
    installFirefox(REQUIRED_ONLY)
    const { service, fetcher, vault } = await connected()

    const result = await service.signout()

    // The tokens are gone from this browser; the remote revocation is reported as unconfirmed.
    expect(result).toMatchObject({ state: "disconnected", remoteRevocationConfirmed: false })
    expect((await vault.read()).credentials).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("does not navigate to the identity provider if the grant is revoked while the sign-in is set up", async () => {
    const permissions = installFirefox(WITH_CREDENTIALS)
    const vault = memoryVault()
    const transport = mockTransport()
    let finishSetup: () => void = () => {}
    vi.mocked(transport.install).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSetup = resolve
        }),
    )
    const service = createByosService(
      vault,
      transport,
      firefoxTarget.extensionId,
      firefoxTarget.callbackUrl,
      vi.fn<typeof fetch>(),
    )
    const started = service.authStart().then(
      () => "started" as const,
      (error: unknown) => error,
    )
    await vi.waitFor(() => expect(transport.install).toHaveBeenCalled())

    permissions.report(REQUIRED_ONLY)
    finishSetup()
    const outcome = await started

    expect(transport.navigate).not.toHaveBeenCalled()
    expect(outcome).not.toBe("started")
    expect((await vault.read()).pending).toBeUndefined()
  })

  it("still reports the local session without asking anything of the network", async () => {
    installFirefox(REQUIRED_ONLY)
    const { service, fetcher } = await connected()

    expect((await service.session()).state).toBe("plan-enabled")

    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe("Firefox without built-in consent support (no data_collection key)", () => {
  it("fails closed: no sign-in tab, no request", async () => {
    installFirefox(undefined)
    const vault = memoryVault()
    const transport = mockTransport()
    const fetcher = vi.fn<typeof fetch>()
    const service = createByosService(
      vault,
      transport,
      firefoxTarget.extensionId,
      firefoxTarget.callbackUrl,
      fetcher,
    )

    await expect(service.authStart()).rejects.toThrow(/consent/i)

    expect(transport.createTab).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("fails closed for the model list", async () => {
    installFirefox(undefined)
    const { service, fetcher } = await connected()

    await expect(service.models()).rejects.toThrow(/consent/i)

    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe("Firefox, authenticationInfo granted", () => {
  it("starts a sign-in: tab, rule and navigation to the identity provider", async () => {
    installFirefox(WITH_CREDENTIALS)
    const { transport } = await signedFixture(SCOPES, firefoxTarget)

    expect(transport.createTab).toHaveBeenCalledTimes(1)
    expect(transport.install).toHaveBeenCalledTimes(1)
    const [, url] = vi.mocked(transport.navigate).mock.calls[0]!
    expect(new URL(url).origin).toBe(ISSUER)
  })

  it("exchanges the code, lists models and runs an inference request", async () => {
    installFirefox(WITH_CREDENTIALS)
    const { service, fetcher } = await connected()

    await expect(service.models()).resolves.toEqual({ models: [] })
    await expect(
      service.invoke({ model: "synthetic-model", text: "Hello" }),
    ).resolves.toMatchObject({
      text: "synthetic result",
    })

    expect(fetcher.mock.calls.map(([input]) => fetchUrl(input))).toEqual([
      `${RESOURCE}/models`,
      `${RESOURCE}/responses`,
    ])
  })

  it("revokes the refresh token on sign-out and confirms it", async () => {
    installFirefox(WITH_CREDENTIALS)
    const { service, fetcher } = await connected()

    const result = await service.signout()

    expect(result).toMatchObject({ state: "disconnected", remoteRevocationConfirmed: true })
    expect(fetcher.mock.calls.map(([input]) => fetchUrl(input))).toContain(
      `${ISSUER}/synthetic-revocation`,
    )
  })

  it("completes a sign-in with the code exchange", async () => {
    installFirefox(WITH_CREDENTIALS)
    const { service, fetcher, query } = await signedFixture(SCOPES, firefoxTarget)

    expect((await service.callback(query, firefoxSender)).state).toBe("plan-enabled")

    expect(fetcher.mock.calls.map(([input]) => fetchUrl(input))).toContain(TOKEN_URL)
  })

  it("stops the next request after a revocation, and honours a later grant with no restart", async () => {
    const permissions = installFirefox(WITH_CREDENTIALS)
    const { service, fetcher } = await connected()
    await service.models()
    expect(fetcher).toHaveBeenCalledTimes(1)

    permissions.report(REQUIRED_ONLY)
    await expect(service.models()).rejects.toThrow(/consent/i)
    expect(fetcher).toHaveBeenCalledTimes(1)

    permissions.report(WITH_CREDENTIALS)
    await expect(service.models()).resolves.toEqual({ models: [] })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe("Chrome build", () => {
  const chromeTarget = { extensionId: "extension", callbackUrl: chromeCallbackUrl }

  it("starts a sign-in without asking the browser for consent", async () => {
    const permissions = installChrome()
    const { transport } = await signedFixture(SCOPES, chromeTarget)

    expect(transport.createTab).toHaveBeenCalledTimes(1)
    expect(transport.navigate).toHaveBeenCalledTimes(1)
    expect(permissions.browserCalls()).toBe(0)
  })

  it("lists models and runs an inference request without asking the browser for consent", async () => {
    const permissions = installChrome()
    const { service, fetcher } = await connected(chromeTarget)

    await expect(service.models()).resolves.toEqual({ models: [] })
    await expect(
      service.invoke({ model: "synthetic-model", text: "Hello" }),
    ).resolves.toMatchObject({
      text: "synthetic result",
    })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(permissions.browserCalls()).toBe(0)
  })
})
