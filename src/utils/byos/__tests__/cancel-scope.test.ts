import { expect, it, vi } from "vitest"
import { createByosService } from "../service"
import { callbackUrl, credentials, memoryVault, mockTransport } from "./auth-fixtures"

it.each([
  { route: "tab-close", reuseId: false },
  { route: "expiry", reuseId: false },
  { route: "tab-close", reuseId: true },
  { route: "expiry", reuseId: true },
])(
  "preserves T2 after a stale internal $route (reused ID: $reuseId)",
  async ({ route, reuseId }) => {
    let now = Date.now()
    const vault = memoryVault(),
      transport = mockTransport(),
      fetcher = vi.fn<typeof fetch>()
    const service = createByosService(
      vault,
      transport,
      "extension",
      callbackUrl,
      fetcher,
      () => now,
    )
    vi.mocked(transport.createTab).mockResolvedValueOnce(42).mockResolvedValueOnce(43)
    const firstId = crypto.randomUUID(),
      secondId = reuseId ? firstId : crypto.randomUUID()
    await service.authStart(firstId)
    const first = (await vault.read()).pending!
    if (route === "expiry") now = first.expires + 1
    const read = vault.read.bind(vault)
    let observed!: () => void,
      release!: () => void,
      armed = true
    const reached = new Promise<void>((resolve) => {
      observed = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vault.read = async () => {
      const snapshot = await read()
      if (armed) {
        armed = false
        observed()
        await gate
      }
      return snapshot
    }
    const cancellation = route === "tab-close" ? service.cancel(first.tabId) : service.expire()
    await reached
    await service.authStart(secondId)
    const before = await vault.read()
    expect(before.pending?.state).not.toBe(first.state)
    expect(before.pending?.tabId).toBe(43)
    expect(before.pending!.expires).toBeGreaterThan(now)
    const cleanupCalls = vi.mocked(transport.cleanup).mock.calls.length
    release()
    await cancellation
    expect(await vault.read()).toEqual(before)
    expect(transport.cleanup).toHaveBeenCalledTimes(cleanupCalls)
    expect(fetcher).not.toHaveBeenCalled()
  },
)

it.each(["tab-close", "expiry"])(
  "still cancels the matching internal %s attempt",
  async (route) => {
    let now = Date.now()
    const vault = memoryVault(),
      transport = mockTransport(),
      fetcher = vi.fn<typeof fetch>()
    const prior = credentials()
    await vault.update((record) => {
      record.credentials = prior
    })
    const service = createByosService(
      vault,
      transport,
      "extension",
      callbackUrl,
      fetcher,
      () => now,
    )
    await service.authStart()
    const pending = (await vault.read()).pending!
    if (route === "expiry") now = pending.expires + 1
    await (route === "tab-close" ? service.cancel(pending.tabId) : service.expire())
    const after = await vault.read()
    expect(after.pending).toBeUndefined()
    expect(after.generation).toBe(pending.generation + 1)
    expect(after.credentials).toEqual(prior)
    expect(transport.cleanup).toHaveBeenLastCalledWith(pending.tabId)
    expect(fetcher).not.toHaveBeenCalled()
  },
)

it("preserves a newer sign-in when stale settings cancel the older attempt", async () => {
  const vault = memoryVault(),
    transport = mockTransport(),
    fetcher = vi.fn<typeof fetch>()
  const service = createByosService(vault, transport, "extension", callbackUrl, fetcher)
  const firstId = crypto.randomUUID(),
    secondId = crypto.randomUUID()
  await service.authStart(firstId)
  const first = (await vault.read()).pending!
  await service.authStart(secondId)
  const second = (await vault.read()).pending!
  expect(second.state).not.toBe(first.state)
  await service.cancelAuth(firstId)
  expect((await vault.read()).pending).toEqual(second)
  expect((await service.session()).authPending).toBe(true)
  expect(fetcher).not.toHaveBeenCalled()
})

it("restores only a safe control identifier and ignores an old cancel after worker restart", async () => {
  const vault = memoryVault(),
    transport = mockTransport(),
    fetcher = vi.fn<typeof fetch>()
  const service = createByosService(vault, transport, "extension", callbackUrl, fetcher)
  const firstId = crypto.randomUUID(),
    secondId = crypto.randomUUID()
  await service.authStart(firstId)
  await service.authStart(secondId)
  const second = (await vault.read()).pending!
  const resumed = createByosService(vault, transport, "extension", callbackUrl, fetcher)
  expect(await resumed.session()).toMatchObject({ authPending: true, authAttemptId: secondId })
  const visible = JSON.stringify(await resumed.session())
  for (const secret of [second.state, second.nonce, second.verifier])
    expect(visible).not.toContain(secret)
  await resumed.cancelAuth(firstId)
  expect((await vault.read()).pending).toEqual(second)
  await resumed.cancelAuth(secondId)
  expect((await vault.read()).pending).toBeUndefined()
  expect(fetcher).not.toHaveBeenCalled()
})

it("cannot invalidate a newer start before its pending record is committed", async () => {
  const vault = memoryVault(),
    transport = mockTransport(),
    fetcher = vi.fn<typeof fetch>()
  const service = createByosService(vault, transport, "extension", callbackUrl, fetcher)
  const firstId = crypto.randomUUID(),
    secondId = crypto.randomUUID()
  await service.authStart(firstId)
  let release!: (available: boolean) => void
  vi.mocked(transport.available).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const start = service.authStart(secondId)
  await vi.waitFor(() => expect(transport.available).toHaveBeenCalledTimes(2))
  await service.cancelAuth(firstId)
  release(true)
  await start
  expect((await vault.read()).pending?.attemptId).toBe(secondId)
  expect(fetcher).not.toHaveBeenCalled()
})

it("can cancel its own start before any tab or pending transaction is created", async () => {
  const vault = memoryVault(),
    transport = mockTransport(),
    fetcher = vi.fn<typeof fetch>()
  const service = createByosService(vault, transport, "extension", callbackUrl, fetcher)
  const id = crypto.randomUUID()
  let release!: (available: boolean) => void
  vi.mocked(transport.available).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const start = service.authStart(id)
  await vi.waitFor(() => expect(transport.available).toHaveBeenCalledOnce())
  await service.cancelAuth(id)
  release(true)
  await expect(start).rejects.toThrow("session_changed")
  expect((await vault.read()).pending).toBeUndefined()
  expect(transport.createTab).not.toHaveBeenCalled()
  expect(fetcher).not.toHaveBeenCalled()
})

it.each([undefined, "not-an-attempt-id"])(
  "rejects a legacy or invalid cancel identifier %s without touching the pending attempt",
  async (id) => {
    const vault = memoryVault(),
      transport = mockTransport()
    const service = createByosService(
      vault,
      transport,
      "extension",
      callbackUrl,
      vi.fn<typeof fetch>(),
    )
    await service.authStart()
    const before = await vault.read()
    await expect(service.cancelAuth(id as string)).rejects.toMatchObject({ name: "ZodError" })
    expect(await vault.read()).toEqual(before)
  },
)

it("assigns a control identifier to a legacy pending record without changing OAuth binding", async () => {
  const vault = memoryVault(),
    transport = mockTransport(),
    fetcher = vi.fn<typeof fetch>()
  const service = createByosService(vault, transport, "extension", callbackUrl, fetcher)
  await service.authStart()
  await vault.update((record) => {
    delete record.pending!.attemptId
  })
  const before = await vault.read()
  const resumed = createByosService(vault, transport, "extension", callbackUrl, fetcher)
  const session = await resumed.session()
  expect(session.authAttemptId).toEqual(expect.any(String))
  expect((await vault.read()).pending).toEqual({
    ...before.pending!,
    attemptId: session.authAttemptId,
  })
  await resumed.cancelAuth(session.authAttemptId!)
  expect((await vault.read()).pending).toBeUndefined()
  expect(fetcher).not.toHaveBeenCalled()
})

it("removes its pending attempt before cleanup failure while preserving the prior account", async () => {
  const vault = memoryVault(),
    transport = mockTransport(),
    fetcher = vi.fn<typeof fetch>()
  const prior = credentials(),
    id = crypto.randomUUID()
  await vault.update((record) => {
    record.credentials = prior
  })
  const service = createByosService(vault, transport, "extension", callbackUrl, fetcher)
  await service.authStart(id)
  vi.mocked(transport.cleanup).mockRejectedValueOnce(new Error("Synthetic cleanup failure"))
  await expect(service.cancelAuth(id)).rejects.toThrow("Synthetic cleanup failure")
  expect(await service.session()).toMatchObject({ state: "plan-enabled", authPending: false })
  expect((await vault.read()).pending).toBeUndefined()
  expect((await vault.read()).credentials).toEqual(prior)
  expect(fetcher).not.toHaveBeenCalled()
})
