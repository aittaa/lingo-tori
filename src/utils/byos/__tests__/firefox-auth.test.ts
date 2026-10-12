import { expect, it, vi } from "vitest"
import { challenge, ISSUER, SCOPES, TOKEN_URL } from "../oidc"
import { createByosService } from "../service"
import { fetchUrl, signedFixture } from "./auth-fixtures"

const target = {
  extensionId: "lingotori@aittaa",
  callbackUrl: "moz-extension://a702f145-d458-4acf-9101-6549d0c2babc/byos-callback.html",
}
const sender = { id: target.extensionId, url: target.callbackUrl, frameId: 0, tab: { id: 42 } }
const fixture = () => signedFixture(SCOPES, target)

it("completes a signed Firefox callback with its UUID origin distinct from the add-on ID", async () => {
  const { service, vault, transport, fetcher, query } = await fixture()
  const pending = (await vault.read()).pending!
  const authorization = new URL(vi.mocked(transport.navigate).mock.calls[0]![1])
  expect(authorization.searchParams.get("code_challenge")).toBe(await challenge(pending.verifier))
  expect(authorization.searchParams.get("redirect_uri")).toBe(pending.redirectUri)
  expect(authorization.searchParams.get("state")).toBe(pending.state)
  expect(authorization.searchParams.get("nonce")).toBe(pending.nonce)
  expect((await service.callback(query, sender)).state).toBe("plan-enabled")
  const exchange = fetcher.mock.calls[0]![1]!.body as URLSearchParams
  expect(exchange.get("code_verifier")).toBe(pending.verifier)
  expect(exchange.get("redirect_uri")).toBe(pending.redirectUri)
  expect((await vault.read()).pending).toBeUndefined()
  await expect(service.callback(query, sender)).rejects.toThrow("invalid_oauth_state")
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it("rejects foreign Firefox origins, IDs, frames, tabs and malformed states before exchanging", async () => {
  const { service, vault, fetcher, query } = await fixture()
  for (const changed of [
    { ...sender, id: "foreign@extension" },
    { ...sender, url: target.callbackUrl.replace("a702f145", "b702f145") },
    { ...sender, url: target.callbackUrl.replace("moz-extension:", "chrome-extension:") },
    { ...sender, url: "https://auth.openai.com/byos-callback.html" },
    { ...sender, url: `${target.callbackUrl}/extra` },
    { ...sender, frameId: 1 },
    { ...sender, tab: { id: 43 } },
  ])
    await expect(service.callback(query, changed)).rejects.toThrow(/./)
  for (const changed of [
    query.replace(/state=[^&]+/, "state=wrong"),
    `${query}&state=duplicate`,
    `${query}&code=duplicate`,
    `${query}&client_id=duplicate`,
  ])
    await expect(service.callback(changed, sender)).rejects.toThrow(/./)
  expect(fetcher).not.toHaveBeenCalled()
  expect((await vault.read()).pending?.claimed).toBeUndefined()
})

it.each(["expired", "generation"])(
  "rejects a Firefox callback with %s pending state",
  async (state) => {
    const { service, vault, fetcher, query } = await fixture()
    await vault.update((record) => {
      if (state === "expired") record.pending!.expires = 1
      else record.generation++
    })
    await expect(service.callback(query, sender)).rejects.toThrow("invalid_oauth_state")
    expect(fetcher).not.toHaveBeenCalled()
  },
)

it("cancels a Firefox attempt and retries with fresh state and PKCE without accepting its old callback", async () => {
  const { service, vault, fetcher, query } = await fixture()
  const original = (await vault.read()).pending!
  await service.cancel(42)
  expect((await vault.read()).pending).toBeUndefined()
  await service.authStart()
  const next = (await vault.read()).pending!
  expect(next.state).not.toBe(original.state)
  expect(next.verifier).not.toBe(original.verifier)
  expect(next.nonce).not.toBe(original.nonce)
  await expect(service.callback(query, sender)).rejects.toThrow("invalid_oauth_state")
  expect(fetcher).not.toHaveBeenCalled()
  const fresh = `?state=${next.state}&code=synthetic-retry&client_id=synthetic-client`
  expect((await service.callback(fresh, sender)).state).toBe("plan-enabled")
})

it("reconciles an unclaimed Firefox attempt after background restart", async () => {
  const { vault, transport, fetcher, query } = await fixture()
  const resumed = createByosService(
    vault,
    transport,
    target.extensionId,
    target.callbackUrl,
    fetcher,
  )
  await resumed.initialize()
  expect(transport.reconcile).toHaveBeenCalledWith((await vault.read()).pending)
  expect((await resumed.callback(query, sender)).state).toBe("plan-enabled")
})

it.each(["nonce", "audience"])(
  "rejects a signed Firefox token with the wrong %s",
  async (claim) => {
    const { service, vault, fetcher, query, keys } = await fixture()
    const pending = (await vault.read()).pending!
    fetcher.mockResolvedValueOnce(
      Response.json({
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: SCOPES,
        id_token: await keys.sign({
          iss: ISSUER,
          aud: claim === "audience" ? "foreign-client" : "synthetic-client",
          nonce: claim === "nonce" ? "wrong-nonce" : pending.nonce,
          exp: Date.now() / 1000 + 3600,
          sub: "synthetic-subject",
        }),
      }),
    )
    await expect(service.callback(query, sender)).rejects.toThrow("invalid_id_token")
    expect((await vault.read()).credentials).toBeUndefined()
    expect(fetchUrl(fetcher.mock.calls[0]![0])).toBe(TOKEN_URL)
  },
)

it("relays only Firefox's exact refused loopback to the strict UUID callback once", async () => {
  const { service, vault, transport, fetcher, query } = await fixture()
  const pending = (await vault.read()).pending!
  const details = {
    url: `${pending.redirectUri}${query}`,
    tabId: 42,
    frameId: 0,
    error: "Error code 2152398861",
  }
  for (const changed of [
    { ...details, error: "net::ERR_CONNECTION_REFUSED" },
    { ...details, error: "Error code 2152398862" },
    { ...details, error: "Error code 2152398934" },
    { ...details, error: "SEC_ERROR_UNKNOWN_ISSUER" },
    { ...details, tabId: 43 },
    { ...details, frameId: 1 },
    { ...details, url: details.url.replace(/state=[^&]+/, "state=wrong") },
  ])
    expect(await service.recoverCallbackNavigation(changed)).toBe(false)
  expect(fetcher).not.toHaveBeenCalled()
  expect(await service.recoverCallbackNavigation(details)).toBe(true)
  const destination = new URL(vi.mocked(transport.navigate).mock.calls.at(-1)![1])
  expect(destination.href.split("?")[0]).toBe(target.callbackUrl)
  expect(Object.fromEntries(destination.searchParams)).toEqual(
    Object.fromEntries(new URLSearchParams(query)),
  )
  expect(await service.recoverCallbackNavigation(details)).toBe(false)
  expect((await service.callback(destination.search, sender)).state).toBe("plan-enabled")
})

it("retires an unconsumed Firefox relay on restart and permits a fresh attempt", async () => {
  const { service, vault, transport, fetcher, query } = await fixture()
  const pending = (await vault.read()).pending!
  expect(
    await service.recoverCallbackNavigation({
      url: `${pending.redirectUri}${query}`,
      tabId: 42,
      frameId: 0,
      error: "Error code 2152398861",
    }),
  ).toBe(true)
  const resumed = createByosService(
    vault,
    transport,
    target.extensionId,
    target.callbackUrl,
    fetcher,
  )
  await resumed.initialize()
  expect((await vault.read()).pending).toBeUndefined()
  await expect(resumed.callback(query, sender)).rejects.toThrow("invalid_oauth_state")
  expect(fetcher).not.toHaveBeenCalled()
  await resumed.authStart()
  expect((await vault.read()).pending?.state).not.toBe(pending.state)
})
