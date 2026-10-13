import type { browser } from "wxt/browser"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { BYOS_UNAVAILABLE_CODE, ByosBridgeError, createByosService } from "../service"
import { AUTH_RULE_ID, createAuthTransport } from "../transport"
import { callbackUrl, memoryVault, mockTransport, sender } from "./auth-fixtures"
const mocks = vi.hoisted(() => ({
  update:
    vi.fn<
      (
        options: Parameters<typeof browser.declarativeNetRequest.updateSessionRules>[0],
      ) => Promise<void>
    >(),
  contains: vi.fn<() => Promise<boolean>>(),
  create: vi.fn<typeof browser.tabs.create>(),
  remove: vi.fn<typeof browser.tabs.remove>(),
  navigate: vi.fn<typeof browser.tabs.update>(),
  alarms: { create: vi.fn<() => Promise<void>>(), clear: vi.fn<() => Promise<boolean>>() },
}))
vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      getURL: (path: string) => `chrome-extension://extension${path}`,
      getManifest: () => ({ permissions: [] }),
    },
    declarativeNetRequest: {
      updateSessionRules: mocks.update,
      getSessionRules: vi.fn<() => Promise<unknown[]>>(),
    },
    permissions: { contains: mocks.contains },
    tabs: { create: mocks.create, remove: mocks.remove, update: mocks.navigate },
    alarms: mocks.alarms,
  },
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.contains.mockResolvedValue(true)
  mocks.update.mockResolvedValue(undefined)
  mocks.create.mockResolvedValue({ id: 42 } as never)
  mocks.alarms.clear.mockResolvedValue(true)
  mocks.remove.mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
function deferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
function observe(operation: Promise<unknown>) {
  const result = { settled: false, error: undefined as unknown }
  void operation.then(
    () => {
      result.settled = true
    },
    (error: unknown) => {
      result.settled = true
      result.error = error
    },
  )
  return result
}
// The sign-in fails during rule installation; only the failure cleanup (the one
// for the opened tab) stays pending until the test settles it.
function failingSignIn() {
  const vault = memoryVault(),
    transport = mockTransport(),
    fetcher = vi.fn<typeof fetch>(),
    cleanup = deferred(),
    failure = new ByosBridgeError("callback_rule_timeout_install")
  let state = ""
  vi.mocked(transport.install).mockImplementationOnce(async (pending) => {
    state = pending.state
    throw failure
  })
  vi.mocked(transport.cleanup).mockImplementation((tabId) =>
    tabId === undefined ? Promise.resolve() : cleanup.promise,
  )
  const service = createByosService(vault, transport, "extension", callbackUrl, fetcher)
  return {
    vault,
    transport,
    fetcher,
    cleanup,
    failure,
    service,
    staleQuery: () => `?state=${state}&code=synthetic-code&client_id=synthetic-client`,
  }
}

it("reports the original sign-in failure while its cleanup is still pending", async () => {
  const { vault, transport, service, failure } = failingSignIn()
  const start = observe(service.authStart())
  await flush()

  expect(start.settled).toBe(true)
  expect(start.error).toBe(failure)
  expect(transport.cleanup).toHaveBeenCalledWith(42)
  expect((await vault.read()).pending).toBeUndefined()
})

it.each(["resolves", "rejects"] as const)(
  "holds the retry gate until failure cleanup %s, then admits a fresh sign-in",
  async (outcome) => {
    const unhandled = vi.fn<(reason: unknown) => void>()
    process.on("unhandledRejection", unhandled)
    try {
      const { transport, service, cleanup, failure } = failingSignIn()
      const start = observe(service.authStart())
      await flush()
      expect(start.error).toBe(failure)
      await expect(service.authStart()).rejects.toMatchObject({ code: "auth_in_progress" })
      expect(transport.createTab).toHaveBeenCalledOnce()

      if (outcome === "resolves") cleanup.resolve()
      else cleanup.reject(new Error("raw cleanup failure"))
      await flush()
      await service.authStart()
      expect(transport.createTab).toHaveBeenCalledTimes(2)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off("unhandledRejection", unhandled)
    }
  },
)

it("rejects the invalidated callback without any upstream request while cleanup is pending", async () => {
  const { fetcher, transport, service, staleQuery } = failingSignIn()
  const start = observe(service.authStart())
  await flush()
  expect(start.settled).toBe(true)
  vi.mocked(transport.cleanup).mockClear()

  await expect(service.callback(staleQuery(), sender)).rejects.toMatchObject({
    code: "invalid_oauth_state",
  })
  expect(fetcher).not.toHaveBeenCalled()
  expect(transport.cleanup).not.toHaveBeenCalled()
})

it("still waits for the pre-auth cleanup before opening a sign-in tab", async () => {
  const transport = mockTransport(),
    preauth = deferred()
  vi.mocked(transport.cleanup).mockImplementationOnce(() => preauth.promise)
  const service = createByosService(
    memoryVault(),
    transport,
    "extension",
    callbackUrl,
    vi.fn<typeof fetch>(),
  )
  const start = observe(service.authStart())
  await flush()
  expect(start.settled).toBe(false)
  expect(transport.createTab).not.toHaveBeenCalled()

  preauth.resolve()
  // This path completes the whole sign-in, including WebCrypto, which one macrotask flush may miss.
  await vi.waitFor(() => expect(start.settled).toBe(true))
  expect(transport.createTab).toHaveBeenCalledOnce()
})

it("delivers the install timeout at its own deadline and keeps rule changes gated until every late mutation settles", async () => {
  vi.useFakeTimers()
  const releases: Array<() => void> = []
  let calls = 0
  mocks.update.mockImplementation(() => {
    calls++
    // Call 3 is the installation and call 4 the failure cleanup's removal; both
    // outlive their 5s bound. Call 5 is the transport's own late-install compensation.
    return calls === 3 || calls === 4
      ? new Promise<void>((resolve) => {
          releases.push(resolve)
        })
      : Promise.resolve()
  })
  const transport = createAuthTransport()
  const service = createByosService(
    memoryVault(),
    transport,
    "extension",
    callbackUrl,
    vi.fn<typeof fetch>(),
  )

  const start = observe(service.authStart())
  await vi.advanceTimersByTimeAsync(5000)
  expect(start).toMatchObject({ settled: true, error: { code: "callback_rule_timeout_install" } })
  expect(mocks.update).toHaveBeenCalledTimes(4)
  expect(await transport.available()).toBe(false)
  await expect(service.authStart()).rejects.toMatchObject({ code: "auth_in_progress" })
  expect(mocks.create).toHaveBeenCalledOnce()

  // The cleanup removal reaches its own bound: the service gate lifts, but both
  // unsettled browser mutations still keep the transport closed.
  await vi.advanceTimersByTimeAsync(5000)
  await expect(service.authStart()).rejects.toMatchObject({ code: BYOS_UNAVAILABLE_CODE })
  expect(mocks.create).toHaveBeenCalledOnce()

  releases[0]!()
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.update).toHaveBeenCalledTimes(5)
  expect(mocks.update.mock.calls[4]![0]).toEqual({ removeRuleIds: [AUTH_RULE_ID] })
  expect(await transport.available()).toBe(false)

  releases[1]!()
  await vi.advanceTimersByTimeAsync(0)
  expect(await transport.available()).toBe(true)
  await service.authStart()
  expect(mocks.create).toHaveBeenCalledTimes(2)
})

it("reopens the transport without compensation when a timed-out install later rejects", async () => {
  vi.useFakeTimers()
  let rejectInstall!: (reason: unknown) => void
  let calls = 0
  mocks.update.mockImplementation(() => {
    calls++
    // Call 3 is the installation; it outlives its 5s bound and then fails, so the
    // rule never applied. Every other mutation, including the cleanup removal, settles.
    return calls === 3
      ? new Promise<void>((_, reject) => {
          rejectInstall = reject
        })
      : Promise.resolve()
  })
  const transport = createAuthTransport()
  const service = createByosService(
    memoryVault(),
    transport,
    "extension",
    callbackUrl,
    vi.fn<typeof fetch>(),
  )

  const start = observe(service.authStart())
  await vi.advanceTimersByTimeAsync(5000)
  expect(start).toMatchObject({ settled: true, error: { code: "callback_rule_timeout_install" } })
  // The service gate has lifted (cleanup settled), but the pending install still holds the transport.
  await expect(service.authStart()).rejects.toMatchObject({ code: BYOS_UNAVAILABLE_CODE })
  expect(await transport.available()).toBe(false)
  expect(mocks.create).toHaveBeenCalledOnce()

  rejectInstall(new Error("late failure"))
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.update).toHaveBeenCalledTimes(4)
  expect(await transport.available()).toBe(true)
  await service.authStart()
  expect(mocks.create).toHaveBeenCalledTimes(2)
})

it("reports the original failure when cleanup throws synchronously, then admits a fresh sign-in", async () => {
  const unhandled = vi.fn<(reason: unknown) => void>()
  process.on("unhandledRejection", unhandled)
  try {
    const { transport, service, failure } = failingSignIn()
    vi.mocked(transport.cleanup).mockImplementation((tabId) => {
      if (tabId === undefined) return Promise.resolve()
      throw new Error("synchronous cleanup failure")
    })
    const start = observe(service.authStart())
    await flush()
    expect(start.settled).toBe(true)
    expect(start.error).toBe(failure)

    await service.authStart()
    expect(transport.createTab).toHaveBeenCalledTimes(2)
    expect(unhandled).not.toHaveBeenCalled()
  } finally {
    process.off("unhandledRejection", unhandled)
  }
})
