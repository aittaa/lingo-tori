// Starting the ChatGPT sign-in reads Firefox's consent just before the authorization page is opened
// in the sign-in tab. That read is asynchronous, and the sign-in can be cancelled, replaced or can
// expire while it is pending. The navigation must belong to the attempt that is still current when
// the read answers: a cancelled attempt never navigates, even while its cleanup is still running
// and the tab has not been removed yet.
//
// These tests drive the real service with a doubled vault, tab transport and `fetch`, hold the
// second consent read (the one right before navigation), and change the attempt while it is held.
//
// These tests do not import the consent module: on the base commit the stale navigation happens.

import type { Mock } from "vitest"
import { afterEach, describe, expect, it, vi } from "vitest"
import { memoryVault, mockTransport } from "@/utils/byos/__tests__/auth-fixtures"
import { createByosService } from "@/utils/byos/service"
import { installFirefox, removePermissionsDouble, WITH_CREDENTIALS } from "./firefox-permissions"

const target = {
  extensionId: "lingotori@aittaa",
  callbackUrl: "moz-extension://a702f145-d458-4acf-9101-6549d0c2babc/byos-callback.html",
}
const ATTEMPT = "7d8f3c52-4f1e-4b1f-9a52-0c3f6d1e2a10"

afterEach(() => {
  vi.useRealTimers()
  removePermissionsDouble()
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** A sign-in about to navigate: the second consent read is held until `releaseConsent()`. */
async function holdingBeforeNavigation(now: () => number = Date.now) {
  const permissions = installFirefox(WITH_CREDENTIALS)
  const consent = deferred()
  let reads = 0
  permissions.getAll.mockImplementation(async () => {
    reads++
    if (reads === 2) await consent.promise
    return { permissions: [], origins: [], data_collection: [...WITH_CREDENTIALS] }
  })
  const vault = memoryVault()
  const transport = mockTransport()
  const fetcher = vi.fn<typeof fetch>()
  const service = createByosService(
    vault,
    transport,
    target.extensionId,
    target.callbackUrl,
    fetcher,
    now,
  )
  const started = service.authStart(ATTEMPT).then(
    () => "navigated" as const,
    (error: unknown) => error,
  )
  await vi.waitFor(() => expect(reads).toBe(2))
  return { vault, transport, service, started, releaseConsent: consent.resolve }
}

const afterTurns = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("a sign-in cancelled while the navigation consent read is pending", () => {
  it("does not navigate, even while the cancelled attempt's cleanup is still running", async () => {
    const { transport, service, started, releaseConsent } = await holdingBeforeNavigation()
    const cleanup = deferred()
    ;(transport.cleanup as Mock).mockImplementation(() => cleanup.promise)

    const cancelled = service.cancelAuth(ATTEMPT)
    await vi.waitFor(() => expect(transport.cleanup).toHaveBeenCalled())
    releaseConsent()
    await afterTurns()

    // The tab is still there and the cleanup has not finished: nothing may open the page now.
    expect(transport.navigate).not.toHaveBeenCalled()

    cleanup.resolve()
    await cancelled
    expect(await started).toMatchObject({ code: "session_changed" })
    expect(transport.navigate).not.toHaveBeenCalled()
  })

  it("does not navigate when the attempt was cancelled and nothing else happened", async () => {
    const { transport, service, started, releaseConsent } = await holdingBeforeNavigation()

    await service.cancelAuth(ATTEMPT)
    releaseConsent()

    expect(await started).toMatchObject({ code: "session_changed" })
    expect(transport.navigate).not.toHaveBeenCalled()
  })
})

describe("a sign-in whose pending record changes while the navigation consent read is pending", () => {
  it("does not navigate for an attempt that expired meanwhile", async () => {
    let clock = 1_000_000
    const { transport, started, releaseConsent } = await holdingBeforeNavigation(() => clock)

    clock += 301_000
    releaseConsent()

    expect(await started).toBeDefined()
    expect(transport.navigate).not.toHaveBeenCalled()
  })

  it("does not navigate for an attempt that another record replaced", async () => {
    const { vault, transport, started, releaseConsent } = await holdingBeforeNavigation()

    await vault.update((record) => {
      if (record.pending) record.pending = { ...record.pending, state: "another-attempt-state" }
    })
    releaseConsent()

    expect(await started).toBeDefined()
    expect(transport.navigate).not.toHaveBeenCalled()
  })
})

describe("a sign-in nobody touches while the navigation consent read is pending", () => {
  it("navigates once, to the authorization page of its own attempt", async () => {
    const { vault, transport, started, releaseConsent } = await holdingBeforeNavigation()
    const pending = (await vault.read()).pending

    releaseConsent()

    expect(await started).toBe("navigated")
    expect(transport.navigate).toHaveBeenCalledTimes(1)
    expect(transport.navigate).toHaveBeenCalledWith(
      pending!.tabId,
      expect.stringContaining(`state=${pending!.state}`),
    )
  })
})
