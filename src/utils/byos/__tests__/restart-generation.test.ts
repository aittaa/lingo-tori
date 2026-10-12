import { expect, it, vi } from "vitest"
import { TOKEN_URL } from "../oidc"
import { createByosService } from "../service"
import { callbackUrl, fetchUrl, sender, signedFixture } from "./auth-fixtures"

async function reconnectFixture() {
  const fixture = await signedFixture()
  await fixture.service.callback(fixture.query, sender)
  await fixture.service.authStart()
  const before = await fixture.vault.read()
  const pending = before.pending!
  fixture.fetcher.mockClear()
  vi.mocked(fixture.transport.reconcile).mockClear()
  return {
    ...fixture,
    before,
    query: `?state=${pending.state}&code=synthetic-reconnect-code&client_id=${pending.clientId}`,
    resumed: createByosService(
      fixture.vault,
      fixture.transport,
      "extension",
      callbackUrl,
      fixture.fetcher,
    ),
  }
}

it("atomically advances a live unclaimed reconnect with an interrupted refresh and reconciles the committed generation", async () => {
  const { vault, transport, fetcher, before, query, resumed } = await reconnectFixture()
  await vault.update((record) => {
    record.refreshing = true
  })
  await resumed.initialize()
  const current = await vault.read()
  expect(fetcher).not.toHaveBeenCalled()
  const result: unknown = await resumed.callback(query, sender).catch((caught: unknown) => caught)
  expect(result).toMatchObject({ state: "plan-enabled", authPending: false })
  expect(current).toMatchObject({
    generation: before.generation + 1,
    tokenVersion: before.tokenVersion + 1,
    refreshUncertain: true,
  })
  expect(current.refreshing).toBeUndefined()
  expect(current.pending).toEqual({ ...before.pending!, generation: current.generation })
  expect(transport.reconcile).toHaveBeenLastCalledWith(current.pending)
  expect(current.credentials).toEqual(before.credentials)
  expect(fetchUrl(fetcher.mock.calls[0]![0])).toBe(TOKEN_URL)
  expect(Object.fromEntries(fetcher.mock.calls[0]![1]!.body as URLSearchParams)).toMatchObject({
    grant_type: "authorization_code",
    code_verifier: before.pending!.verifier,
  })
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it("retires an already-stale reconnect instead of rebinding it to the new generation", async () => {
  const { vault, transport, fetcher, before, query, resumed } = await reconnectFixture()
  await vault.update((record) => {
    record.refreshing = true
    record.pending!.generation += 100
  })
  await resumed.initialize()
  expect((await vault.read()).pending).toBeUndefined()
  expect((await vault.read()).credentials).toEqual(before.credentials)
  expect(transport.reconcile).not.toHaveBeenCalled()
  await expect(resumed.callback(query, sender)).rejects.toThrow("invalid_oauth_state")
  expect(fetcher).not.toHaveBeenCalled()
})

it.each(["claimed", "expired"])(
  "never revives a %s reconnect while recovering an interrupted refresh",
  async (state) => {
    const { vault, fetcher, before, query, resumed } = await reconnectFixture()
    await vault.update((record) => {
      record.refreshing = true
      if (state === "claimed") record.pending!.claimed = true
      else record.pending!.expires = 1
    })
    await resumed.initialize()
    expect((await vault.read()).pending).toBeUndefined()
    expect((await vault.read()).credentials).toEqual(before.credentials)
    await expect(resumed.callback(query, sender)).rejects.toThrow("invalid_oauth_state")
    expect(fetcher).not.toHaveBeenCalled()
  },
)
