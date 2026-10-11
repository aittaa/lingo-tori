import { expect, it, vi } from "vitest"
import { createByosService } from "../service"
import { callbackUrl, memoryVault, mockTransport, sender, signedFixture } from "./auth-fixtures"
async function fixture(clock: () => number = Date.now) {
  const vault = memoryVault(),
    transport = mockTransport(),
    fetcher = vi.fn<typeof fetch>()
  const service = createByosService(vault, transport, "extension", callbackUrl, fetcher, clock)
  await service.authStart()
  const pending = (await vault.read()).pending!
  const url = `${pending.redirectUri}?state=${pending.state}&code=synthetic-code&client_id=synthetic-client`
  return {
    vault,
    transport,
    fetcher,
    service,
    url,
    details: { url, tabId: 42, frameId: 0, error: "net::ERR_CONNECTION_REFUSED" },
  }
}
it("relays an exact refused callback once into the existing strict callback flow", async () => {
  const { vault, transport, fetcher, service, query } = await signedFixture()
  const pending = (await vault.read()).pending!
  const details = {
    url: `${pending.redirectUri}${query}&scope=ignored&message=ignored&unknown=ignored`,
    tabId: 42,
    frameId: 0,
    error: "net::ERR_CONNECTION_REFUSED",
  }
  expect(await service.recoverCallbackNavigation(details)).toBe(true)
  const destination = new URL(vi.mocked(transport.navigate).mock.calls.at(-1)![1])
  expect(destination.protocol).toBe("chrome-extension:")
  expect(destination.hostname).toBe("extension")
  expect(destination.pathname).toBe("/byos-callback.html")
  expect([...destination.searchParams.keys()].sort()).toEqual(["client_id", "code", "state"])
  expect((await vault.read()).pending).toMatchObject({ relayStarted: true })
  expect((await vault.read()).pending?.claimed).toBeUndefined()
  expect(fetcher).not.toHaveBeenCalled()
  expect(await service.recoverCallbackNavigation(details)).toBe(false)
  expect(transport.navigate).toHaveBeenCalledTimes(2)
  expect((await service.callback(destination.search, sender)).state).toBe("plan-enabled")
  expect(fetcher).toHaveBeenCalledTimes(3)
})
it("rejects unrelated frames, tabs, states, paths, ports, warnings, duplicates, fragments and ambiguous results", async () => {
  const { service, details, url, transport, fetcher, vault } = await fixture()
  const original = new URL(url)
  const wrongPort = new URL(url)
  wrongPort.port = String(Number(original.port) === 65535 ? 65534 : Number(original.port) + 1)
  const invalid = [
    { ...details, frameId: 1 },
    { ...details, tabId: 43 },
    { ...details, tabId: -1 },
    { ...details, error: "net::ERR_CERT_AUTHORITY_INVALID" },
    { ...details, error: "net::ERR_NAME_NOT_RESOLVED" },
    { ...details, url: url.replace("127.0.0.1", "localhost") },
    { ...details, url: url.replace("http:", "https:") },
    { ...details, url: wrongPort.href },
    { ...details, url: url.replace("/auth/callback?", "/auth/callback/extra?") },
    { ...details, url: url.replace("http://", "http://user:password@") },
    { ...details, url: `${url}#fragment` },
    { ...details, url: url.replace(/state=[^&]+/, "state=wrong") },
    { ...details, url: `${url}&state=duplicate` },
    { ...details, url: `${url}&code=duplicate` },
    { ...details, url: `${url}&client_id=duplicate` },
    { ...details, url: `${url}&error=access_denied` },
    { ...details, url: url.replace("code=synthetic-code", "code=") },
    { ...details, url: url.replace("code=synthetic-code", "error=access_denied&error=duplicate") },
    { ...details, url: url.replace("code=synthetic-code&", "") },
    { ...details, url: `${url}&unknown=${"a".repeat(16000)}` },
  ]
  for (const failure of invalid)
    expect(await service.recoverCallbackNavigation(failure)).toBe(false)
  expect(transport.navigate).toHaveBeenCalledOnce()
  expect(fetcher).not.toHaveBeenCalled()
  expect((await vault.read()).pending?.relayStarted).toBeUndefined()
})
it.each(["claimed", "expired", "generation"])("does not relay %s pending state", async (state) => {
  const { service, vault, details, transport, fetcher } = await fixture()
  await vault.update((record) => {
    if (state === "claimed") record.pending!.claimed = true
    else if (state === "expired") record.pending!.expires = 1
    else record.generation++
  })
  expect(await service.recoverCallbackNavigation(details)).toBe(false)
  expect(transport.navigate).toHaveBeenCalledOnce()
  expect(fetcher).not.toHaveBeenCalled()
})
it("persists duplicate-relay protection across worker restart", async () => {
  const { service, vault, details, transport, fetcher } = await fixture()
  expect(await service.recoverCallbackNavigation(details)).toBe(true)
  const resumed = createByosService(vault, transport, "extension", callbackUrl, fetcher)
  expect(await resumed.recoverCallbackNavigation(details)).toBe(false)
  expect(transport.navigate).toHaveBeenCalledTimes(2)
})
it("cannot navigate after cancellation changes the generation during the relay guard", async () => {
  const { service, vault, details, transport, fetcher } = await fixture()
  const originalRead = vault.read.bind(vault)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const read = vi.spyOn(vault, "read").mockImplementationOnce(async () => {
    await gate
    return originalRead()
  })
  const relay = service.recoverCallbackNavigation(details)
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
  await service.cancel()
  release()
  expect(await relay).toBe(false)
  expect(transport.navigate).toHaveBeenCalledOnce()
  expect(fetcher).not.toHaveBeenCalled()
})
it("does not recover closed attempts, failed tab updates, or Firefox callbacks", async () => {
  const { service, vault, details, transport, fetcher } = await fixture()
  vi.mocked(transport.navigate).mockRejectedValueOnce(new Error("synthetic closed tab"))
  expect(await service.recoverCallbackNavigation(details)).toBe(false)
  await service.cancel(42)
  expect(await service.recoverCallbackNavigation(details)).toBe(false)
  const firefox = createByosService(
    vault,
    transport,
    "extension",
    "moz-extension://extension/byos-callback.html",
    fetcher,
  )
  expect(await firefox.recoverCallbackNavigation(details)).toBe(false)
  expect(fetcher).not.toHaveBeenCalled()
})
it("relays consent denial without exchanging a token or retaining unknown query fields", async () => {
  const { service, details, url, transport, fetcher } = await fixture()
  expect(
    await service.recoverCallbackNavigation({
      ...details,
      url: url.replace("code=synthetic-code", "error=access_denied") + "&error_description=ignored",
    }),
  ).toBe(true)
  const destination = new URL(vi.mocked(transport.navigate).mock.calls.at(-1)![1])
  expect([...destination.searchParams.keys()].sort()).toEqual(["client_id", "error", "state"])
  await expect(service.callback(destination.search, sender)).rejects.toThrow("consent_denied")
  expect(fetcher).not.toHaveBeenCalled()
})

it("does not relay after callback permission is withdrawn", async () => {
  const { service, details, transport, vault, fetcher } = await fixture()
  vi.mocked(transport.available).mockResolvedValue(false)
  expect(await service.recoverCallbackNavigation(details)).toBe(false)
  expect((await vault.read()).pending?.relayStarted).toBeUndefined()
  expect(transport.navigate).toHaveBeenCalledOnce()
  expect(fetcher).not.toHaveBeenCalled()
})

it("does not relay after expiry while the post-claim guard is awaiting storage", async () => {
  let clock = 1000000
  const { service, vault, details, transport } = await fixture(() => clock)
  const originalRead = vault.read.bind(vault)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const read = vi.spyOn(vault, "read").mockImplementationOnce(async () => {
    await gate
    return originalRead()
  })
  const relay = service.recoverCallbackNavigation(details)
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
  clock += 300001
  release()
  expect(await relay).toBe(false)
  expect(transport.navigate).toHaveBeenCalledOnce()
})
