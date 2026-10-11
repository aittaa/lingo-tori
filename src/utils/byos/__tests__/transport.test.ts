import type { browser } from "wxt/browser"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { AUTH_RULE_ID, buildCallbackRule, createAuthTransport } from "../transport"
const mocks = vi.hoisted(() => ({
  dnrAvailable: true,
  update:
    vi.fn<
      (
        options: Parameters<typeof browser.declarativeNetRequest.updateSessionRules>[0],
      ) => Promise<void>
    >(),
  contains: vi.fn<() => Promise<boolean>>(),
  create: vi.fn<typeof browser.tabs.create>(),
  remove: vi.fn<typeof browser.tabs.remove>(),
  get: vi.fn<(tabId: number) => Promise<{ id: number; url: string }>>(),
  alarms: { create: vi.fn<() => Promise<void>>(), clear: vi.fn<() => Promise<boolean>>() },
  rules: vi.fn<() => Promise<ReturnType<typeof buildCallbackRule>[]>>(),
}))
vi.mock("wxt/browser", () => ({
  browser: {
    runtime: { getURL: (path: string) => `chrome-extension://extension${path}` },
    get declarativeNetRequest() {
      return mocks.dnrAvailable
        ? { updateSessionRules: mocks.update, getSessionRules: mocks.rules }
        : undefined
    },
    permissions: { contains: mocks.contains },
    tabs: { create: mocks.create, remove: mocks.remove, get: mocks.get },
    alarms: mocks.alarms,
  },
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.dnrAvailable = true
  mocks.contains.mockResolvedValue(true)
  mocks.update.mockResolvedValue(undefined)
  mocks.alarms.clear.mockResolvedValue(true)
  mocks.remove.mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())
it("compensates a timed-out rule installation that settles after cleanup", async () => {
  vi.useFakeTimers()
  let release!: () => void
  const late = new Promise<void>((resolve) => {
    release = resolve
  })
  mocks.update.mockReturnValueOnce(late)
  const transport = createAuthTransport()
  const install = transport.install({
    state: "state",
    nonce: "nonce",
    verifier: "verifier",
    redirectUri: "http://127.0.0.1:51000/auth/callback",
    tabId: 42,
    expires: Date.now() + 300000,
    generation: 1,
  })
  const outcome = install.then(
    () => null,
    (error: unknown) => error,
  )
  await vi.advanceTimersByTimeAsync(5000)
  expect(await outcome).toMatchObject({ message: "BYOS: callback_rule_timeout" })
  expect(await transport.available()).toBe(false)
  await transport.cleanup()
  release()
  await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(3))
  expect(mocks.update.mock.calls[2]).toEqual([{ removeRuleIds: [AUTH_RULE_ID] }])
  await vi.waitFor(async () => expect(await transport.available()).toBe(true))
})
it("never installs an unscoped callback rule", async () => {
  const transport = createAuthTransport()
  await transport.install({
    state: "state",
    nonce: "nonce",
    verifier: "verifier",
    redirectUri: "http://127.0.0.1:51000/auth/callback",
    tabId: 42,
    expires: Date.now() + 300000,
    generation: 1,
  })
  expect(mocks.update.mock.calls[0]![0].addRules![0]!.condition.tabIds).toEqual([42])
  expect(mocks.update.mock.calls[0]![0].addRules![0]!.condition.resourceTypes).toEqual([
    "main_frame",
  ])
})

it("resolves the routing API after a later grant and accepts semantically identical reordered rules", async () => {
  mocks.dnrAvailable = false
  const transport = createAuthTransport()
  expect(await transport.available()).toBe(false)
  mocks.dnrAvailable = true
  const pending = {
    state: "state",
    nonce: "nonce",
    verifier: "verifier",
    redirectUri: "http://127.0.0.1:51000/auth/callback",
    tabId: 42,
    expires: Date.now() + 300000,
    generation: 1,
  }
  await transport.install(pending)
  const rule = buildCallbackRule(
    42,
    "chrome-extension://extension/byos-callback.html",
    pending.redirectUri,
  )
  mocks.get.mockResolvedValue({
    id: 42,
    url: "https://auth.openai.com/api/accounts/authorize",
  })
  mocks.rules.mockResolvedValue([
    {
      ...rule,
      action: { redirect: rule.action.redirect, type: "redirect" },
      condition: {
        requestMethods: ["get"],
        resourceTypes: ["main_frame"],
        tabIds: [42],
        isUrlFilterCaseSensitive: true,
        regexFilter: rule.condition.regexFilter,
      },
    },
  ])
  expect(await transport.reconcile(pending)).toBe(true)
})
