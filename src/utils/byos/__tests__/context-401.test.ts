import { expect, it, vi } from "vitest"
import { RESOURCE, SCOPES, TOKEN_URL } from "../oidc"
import { createByosService } from "../service"
import { callbackUrl, credentials, fetchUrl, memoryVault, mockTransport } from "./auth-fixtures"

async function setup(fetcher: typeof fetch) {
  const vault = memoryVault()
  await vault.update((record) => {
    record.credentials = credentials()
  })
  return {
    vault,
    service: createByosService(vault, mockTransport(), "extension", callbackUrl, fetcher),
  }
}
const rotatedTokens = () => ({
  access_token: "synthetic-new-access",
  refresh_token: "synthetic-new-refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope: SCOPES,
})

it.each([
  ["models", "subscription_sharing_invalid_user"],
  ["responses", "subscription_sharing_invalid_user"],
  ["models", "authorization_required"],
  ["responses", "authorization_required"],
])(
  "fails closed for %s / %s without poisoning otherwise valid credentials",
  async (route, code) => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      expect(fetchUrl(url)).toBe(
        `${RESOURCE}/${fetcher.mock.calls.length === 1 ? route : "models"}`,
      )
      if (fetcher.mock.calls.length === 1) {
        return Response.json(
          code === "authorization_required"
            ? { detail: "Synthetic admission diagnostic" }
            : { error: { code } },
          { status: 401, headers: { "x-request-id": "req_synthetic_context_401" } },
        )
      }
      return Response.json({ models: [] })
    })
    const { vault, service } = await setup(fetcher)
    const before = await vault.read()
    await expect(
      route === "models"
        ? service.models()
        : service.invoke({ model: "synthetic-model", text: "source" }),
    ).rejects.toMatchObject({
      code,
      status: 401,
      requestId: "req_synthetic_context_401",
      failQueue: false,
    })
    expect(await vault.read()).toEqual(before)
    expect(await service.session()).toMatchObject({ state: "plan-enabled" })
    expect(await service.models()).toEqual({ models: [] })
    expect(fetcher).toHaveBeenCalledTimes(2)
  },
)

it("does not reject a newly rotated token when the one bounded resend has a contextual 401", async () => {
  let modelCalls = 0,
    refreshCalls = 0
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    if (fetchUrl(url) === TOKEN_URL) {
      refreshCalls++
      return Response.json(rotatedTokens())
    }
    modelCalls++
    expect(new Headers(options?.headers).get("Authorization")).toBe(
      modelCalls === 1 ? "Bearer synthetic-access" : "Bearer synthetic-new-access",
    )
    if (modelCalls <= 2)
      return Response.json(
        {
          error: { code: modelCalls === 1 ? "invalid_token" : "subscription_sharing_invalid_user" },
        },
        { status: 401 },
      )
    return Response.json({ models: [] })
  })
  const { service, vault } = await setup(fetcher)
  await expect(service.models()).rejects.toMatchObject({
    code: "subscription_sharing_invalid_user",
    failQueue: false,
  })
  expect((await vault.read()).accessRejected).toBeUndefined()
  expect((await vault.read()).credentials?.accessToken).toBe("synthetic-new-access")
  expect(await service.models()).toEqual({ models: [] })
  expect(modelCalls).toBe(3)
  expect(refreshCalls).toBe(1)
})

it("still blocks a token explicitly rejected after one rotation without refreshing again", async () => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    fetchUrl(url) === TOKEN_URL
      ? Response.json(rotatedTokens())
      : Response.json({ error: { code: "invalid_token" } }, { status: 401 }),
  )
  const { service, vault } = await setup(fetcher)
  await expect(service.models()).rejects.toMatchObject({ code: "invalid_token", status: 401 })
  expect((await vault.read()).accessRejected).toBe(true)
  expect((await service.session()).state).toBe("reconnect-required")
  await expect(service.models()).rejects.toThrow("authorization_required")
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it("preserves valid access after an uncertain refresh and contextual 401, but never reuses the refresh token", async () => {
  let modelCalls = 0
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (fetchUrl(url) === TOKEN_URL) throw new Error("Synthetic lost rotation response")
    return ++modelCalls === 1
      ? Response.json({ error: { code: "subscription_sharing_invalid_user" } }, { status: 401 })
      : Response.json({ models: [] })
  })
  const { service, vault } = await setup(fetcher)
  await vault.update((record) => {
    record.credentials!.expires = Date.now() + 20000
  })
  await expect(service.models()).rejects.toMatchObject({
    code: "subscription_sharing_invalid_user",
  })
  expect((await vault.read()).refreshUncertain).toBe(true)
  expect((await vault.read()).accessRejected).toBeUndefined()
  expect(await service.models()).toEqual({ models: [] })
  await vault.update((record) => {
    record.credentials!.expires = 1
  })
  await expect(service.models()).rejects.toThrow("reconnect-required")
  expect(fetcher).toHaveBeenCalledTimes(3)
})
