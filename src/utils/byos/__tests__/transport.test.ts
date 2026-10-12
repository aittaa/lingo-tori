import type { browser } from "wxt/browser"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { AUTH_RULE_ID, buildCallbackRule, createAuthTransport } from "../transport"
const mocks = vi.hoisted(() => ({
  dnrAvailable: true,
  protocol: "chrome-extension:",
  host: "extension",
  installedPermission: true,
  navigationRecovery: false,
  update:
    vi.fn<
      (
        options: Parameters<typeof browser.declarativeNetRequest.updateSessionRules>[0],
      ) => Promise<void>
    >(),
  contains: vi.fn<() => Promise<boolean>>(),
  create: vi.fn<typeof browser.tabs.create>(),
  remove: vi.fn<typeof browser.tabs.remove>(),
  get: vi.fn<(tabId: number) => Promise<{ id: number; url?: string }>>(),
  alarms: { create: vi.fn<() => Promise<void>>(), clear: vi.fn<() => Promise<boolean>>() },
  rules: vi.fn<() => Promise<ReturnType<typeof buildCallbackRule>[]>>(),
}))
vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      getURL: (path: string) => `${mocks.protocol}//${mocks.host}${path}`,
      getManifest: () => ({
        permissions: mocks.installedPermission ? ["declarativeNetRequestWithHostAccess"] : [],
      }),
    },
    get declarativeNetRequest() {
      return mocks.dnrAvailable
        ? { updateSessionRules: mocks.update, getSessionRules: mocks.rules }
        : undefined
    },
    permissions: { contains: mocks.contains },
    get webNavigation() {
      return mocks.navigationRecovery ? { onErrorOccurred: {} } : undefined
    },
    tabs: { create: mocks.create, remove: mocks.remove, get: mocks.get },
    alarms: mocks.alarms,
  },
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.dnrAvailable = true
  mocks.protocol = "chrome-extension:"
  mocks.host = "extension"
  mocks.installedPermission = true
  mocks.navigationRecovery = false
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

it("blocks a new sign-in until timed-out cleanup can no longer delete its rule", async () => {
  vi.useFakeTimers()
  let release!: () => void
  mocks.update.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve
    }),
  )
  const transport = createAuthTransport()
  const cleanup = transport.cleanup().catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(5000)
  expect(await cleanup).toMatchObject({ message: "BYOS: callback_rule_timeout" })
  expect(await transport.available()).toBe(false)
  await expect(
    transport.install({
      state: "new-state",
      nonce: "new-nonce",
      verifier: "new-verifier",
      redirectUri: "http://127.0.0.1:51001/auth/callback",
      tabId: 43,
      expires: Date.now() + 300000,
      generation: 2,
    }),
  ).rejects.toThrow("callback_permission_required")
  expect(mocks.update).toHaveBeenCalledOnce()

  release()
  await vi.waitFor(async () => expect(await transport.available()).toBe(true))
})

it.each(["alarm", "permission"] as const)(
  "gates sign-in before delayed %s cleanup can delete a newer rule",
  async (stage) => {
    vi.useFakeTimers()
    let release!: (value: boolean) => void
    const delayed = new Promise<boolean>((resolve) => {
      release = resolve
    })
    if (stage === "alarm") mocks.alarms.clear.mockReturnValueOnce(delayed)
    else mocks.contains.mockReturnValueOnce(delayed)
    const transport = createAuthTransport()
    const cleanup = transport.cleanup()
    await vi.advanceTimersByTimeAsync(6500)

    expect(await transport.available()).toBe(false)
    await expect(
      transport.install({
        state: "new-state",
        nonce: "new-nonce",
        verifier: "new-verifier",
        redirectUri: "http://127.0.0.1:51001/auth/callback",
        tabId: 43,
        expires: Date.now() + 300000,
        generation: 2,
      }),
    ).rejects.toThrow("callback_permission_required")
    expect(mocks.update).not.toHaveBeenCalled()

    release(true)
    await cleanup
    expect(await transport.available()).toBe(true)
    expect(mocks.update).toHaveBeenCalledOnce()
  },
)

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

it.each([
  undefined,
  "",
  "about:blank",
  "https://accounts.example.test/second-factor",
  "http://127.0.0.1:51000/auth/callback?code=synthetic&state=synthetic",
])("preserves a pending callback rule across a worker restart at %s", async (url) => {
  const pending = {
    state: "synthetic",
    nonce: "synthetic",
    verifier: "synthetic",
    redirectUri: "http://127.0.0.1:51000/auth/callback",
    tabId: 42,
    expires: Date.now() + 300000,
    generation: 1,
  }
  mocks.get.mockResolvedValue({ id: 42, url })
  mocks.rules.mockResolvedValue([
    buildCallbackRule(42, "chrome-extension://extension/byos-callback.html", pending.redirectUri),
  ])

  expect(await createAuthTransport().reconcile(pending)).toBe(true)
  expect(mocks.update).not.toHaveBeenCalled()
  expect(mocks.alarms.create).toHaveBeenCalledOnce()
})

it("still rejects a callback rule scoped to a different tab after restart", async () => {
  mocks.navigationRecovery = true
  const pending = {
    state: "synthetic",
    nonce: "synthetic",
    verifier: "synthetic",
    redirectUri: "http://127.0.0.1:51000/auth/callback",
    tabId: 42,
    expires: Date.now() + 300000,
    generation: 1,
  }
  mocks.get.mockResolvedValue({ id: 42, url: "https://accounts.example.test/second-factor" })
  mocks.rules.mockResolvedValue([
    buildCallbackRule(43, "chrome-extension://extension/byos-callback.html", pending.redirectUri),
  ])

  expect(await createAuthTransport().reconcile(pending)).toBe(false)
  expect(mocks.update).toHaveBeenCalledWith({ removeRuleIds: [AUTH_RULE_ID] })
})

it("retains a pending callback with a missing rule only when navigation recovery exists", async () => {
  const pending = {
    state: "synthetic",
    nonce: "synthetic",
    verifier: "synthetic",
    redirectUri: "http://127.0.0.1:51000/auth/callback",
    tabId: 42,
    expires: Date.now() + 300000,
    generation: 1,
  }
  mocks.get.mockResolvedValue({ id: 42, url: pending.redirectUri })
  mocks.rules.mockResolvedValue([])
  mocks.navigationRecovery = true
  expect(await createAuthTransport().reconcile(pending)).toBe(true)
  expect(mocks.update).not.toHaveBeenCalled()

  mocks.navigationRecovery = false
  expect(await createAuthTransport().reconcile(pending)).toBe(false)
  expect(mocks.update).toHaveBeenCalledWith({ removeRuleIds: [AUTH_RULE_ID] })

  mocks.navigationRecovery = true
  mocks.contains.mockResolvedValue(false)
  expect(await createAuthTransport().reconcile(pending)).toBe(false)
})

it("installs and reconciles Firefox routing with its runtime UUID and declared capability", async () => {
  mocks.protocol = "moz-extension:"
  mocks.host = "a702f145-d458-4acf-9101-6549d0c2babc"
  const transport = createAuthTransport()
  mocks.installedPermission = false
  expect(await transport.available()).toBe(false)
  expect(mocks.contains).not.toHaveBeenCalled()
  mocks.installedPermission = true
  const pending = {
    state: "synthetic",
    nonce: "synthetic",
    verifier: "synthetic",
    redirectUri: "http://127.0.0.1:51000/auth/callback",
    tabId: 42,
    expires: Date.now() + 300000,
    generation: 1,
  }
  await transport.install(pending)
  const rule = mocks.update.mock.calls[0]![0].addRules![0]!
  expect(rule).toMatchObject({
    action: {
      redirect: {
        transform: {
          scheme: "moz-extension",
          host: mocks.host,
          path: "/byos-callback.html",
        },
      },
    },
    condition: { tabIds: [42], resourceTypes: ["main_frame"], requestMethods: ["get"] },
  })
  expect(rule.action.redirect?.transform?.query).toBeUndefined()
  mocks.get.mockResolvedValue({ id: 42, url: "https://auth.openai.com/api/accounts/authorize" })
  mocks.rules.mockResolvedValue([
    buildCallbackRule(42, `moz-extension://${mocks.host}/byos-callback.html`, pending.redirectUri),
  ])
  expect(await transport.reconcile(pending)).toBe(true)
  await transport.cleanup(42)
  expect(mocks.update).toHaveBeenLastCalledWith({ removeRuleIds: [AUTH_RULE_ID] })
  expect(mocks.remove).toHaveBeenCalledWith(42)
})

it("fails closed on missing Firefox capability or foreign runtime protocols", async () => {
  mocks.protocol = "moz-extension:"
  const transport = createAuthTransport()
  expect(await transport.available()).toBe(true)
  mocks.installedPermission = false
  await expect(
    transport.install({
      state: "synthetic",
      nonce: "synthetic",
      verifier: "synthetic",
      redirectUri: "http://127.0.0.1:51000/auth/callback",
      tabId: 42,
      expires: Date.now() + 300000,
      generation: 1,
    }),
  ).rejects.toThrow("callback_permission_required")
  expect(mocks.update).not.toHaveBeenCalled()
  mocks.installedPermission = true
  mocks.protocol = "https:"
  expect(await transport.available()).toBe(false)
  expect(() =>
    buildCallbackRule(
      42,
      "https://foreign.example/byos-callback.html",
      "http://127.0.0.1:51000/auth/callback",
    ),
  ).toThrow("invalid_callback_route")
})
