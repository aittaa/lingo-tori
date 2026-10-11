import type { PendingAuth } from "./vault"
import { browser } from "wxt/browser"
import { ByosBridgeError } from "./service"

export const AUTH_RULE_ID = 1749225500
export const AUTH_ALARM = "lingotori-browser-byos-auth-expiry"
export const CALLBACK_PATH = "/byos-callback.html" as Parameters<typeof browser.runtime.getURL>[0]
export function createRedirectUri() {
  const random = crypto.getRandomValues(new Uint16Array(1))[0]!
  return `http://127.0.0.1:${49152 + (random % 16384)}/auth/callback`
}
export function callbackRegex(redirectUri: string) {
  const url = new URL(redirectUri)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    Number(url.port) < 49152 ||
    url.pathname !== "/auth/callback" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new ByosBridgeError("invalid_redirect_uri")
  return `^http://127\\.0\\.0\\.1:${url.port}/auth/callback\\?[^#]*$`
}
export interface AuthTransport {
  available: () => Promise<boolean>
  createTab: () => Promise<number>
  install: (pending: PendingAuth) => Promise<void>
  navigate: (tabId: number, authorizationUrl: string) => Promise<void>
  cleanup: (tabId?: number) => Promise<void>
  reconcile: (pending?: PendingAuth) => Promise<boolean>
}
export function buildCallbackRule(tabId: number, callbackUrl: string, redirectUri: string) {
  const callback = new URL(callbackUrl)
  if (
    !Number.isSafeInteger(tabId) ||
    tabId < 0 ||
    callback.protocol !== "chrome-extension:" ||
    callback.pathname !== "/byos-callback.html" ||
    callback.search ||
    callback.hash ||
    callback.username ||
    callback.password
  )
    throw new ByosBridgeError("invalid_callback_route")
  return {
    id: AUTH_RULE_ID,
    priority: 1,
    action: {
      type: "redirect" as const,
      redirect: {
        transform: {
          scheme: callback.protocol.slice(0, -1),
          host: callback.hostname,
          path: callback.pathname,
          port: "",
          username: "",
          password: "",
          fragment: "",
        },
      },
    },
    condition: {
      regexFilter: callbackRegex(redirectUri),
      isUrlFilterCaseSensitive: true,
      tabIds: [tabId],
      resourceTypes: ["main_frame" as const],
      requestMethods: ["get" as const],
    },
  }
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new ByosBridgeError("callback_rule_timeout")), 5000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, candidate: unknown) => {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate))
      return Object.fromEntries(
        Object.entries(candidate).sort(([left], [right]) => left.localeCompare(right)),
      )
    return candidate
  })
export function createAuthTransport(): AuthTransport {
  const api = () => browser.declarativeNetRequest
  let uncertainInstall = false
  let pendingRuleChanges = 0
  const updateRules = (
    dnr: typeof browser.declarativeNetRequest,
    options: Parameters<typeof browser.declarativeNetRequest.updateSessionRules>[0],
  ) => {
    pendingRuleChanges++
    try {
      return dnr.updateSessionRules(options).finally(() => pendingRuleChanges--)
    } catch (error) {
      pendingRuleChanges--
      return Promise.reject(error)
    }
  }
  const removeRule = async () => {
    pendingRuleChanges++
    try {
      const dnr = api()
      if (
        dnr &&
        (await browser.permissions.contains({
          permissions: ["declarativeNetRequestWithHostAccess"],
        }))
      )
        await bounded(updateRules(dnr, { removeRuleIds: [AUTH_RULE_ID] }))
    } finally {
      pendingRuleChanges--
    }
  }
  return {
    async available() {
      // The experimental transport is Chromium-only until separately verified.
      return (
        browser.runtime.getURL("/").startsWith("chrome-extension://") &&
        !!api() &&
        (await browser.permissions.contains({
          permissions: ["declarativeNetRequestWithHostAccess"],
        })) &&
        !uncertainInstall &&
        pendingRuleChanges === 0
      )
    },
    async createTab() {
      const tab = await browser.tabs.create({ url: "about:blank" })
      if (tab.id === undefined || !Number.isSafeInteger(tab.id) || tab.id < 0)
        throw new ByosBridgeError("auth_tab_unavailable")
      return tab.id
    },
    async install(pending) {
      const dnr = api()
      if (!dnr || !(await this.available()))
        throw new ByosBridgeError("callback_permission_required")
      uncertainInstall = true
      const install = updateRules(dnr, {
        removeRuleIds: [AUTH_RULE_ID],
        addRules: [
          buildCallbackRule(
            pending.tabId,
            browser.runtime.getURL(CALLBACK_PATH),
            pending.redirectUri,
          ),
        ],
      })
      try {
        await bounded(install)
      } catch (error) {
        // A timed-out installation can still settle later; remove it again then.
        void install
          .then(
            async () => {
              await removeRule()
              uncertainInstall = false
            },
            () => {
              uncertainInstall = false
            },
          )
          .catch(() => {})
        throw error
      }
      uncertainInstall = false
      await browser.alarms.create(AUTH_ALARM, { when: pending.expires })
    },
    async navigate(tabId, authorizationUrl) {
      await browser.tabs.update(tabId, { url: authorizationUrl })
    },
    async cleanup(tabId) {
      // A caller may time out before Chrome even starts deleting the rule.
      // Keep new sign-ins gated through every await and actual mutation.
      pendingRuleChanges++
      try {
        await browser.alarms.clear(AUTH_ALARM)
        await removeRule()
        if (tabId !== undefined) await browser.tabs.remove(tabId).catch(() => {})
      } finally {
        pendingRuleChanges--
      }
    },
    async reconcile(pending) {
      if (!pending || !(await this.available())) {
        await removeRule()
        return false
      }
      const tab = await browser.tabs.get(pending.tabId).catch(() => undefined)
      if (!tab) {
        await removeRule()
        return false
      }
      // The committed URL can be blank, an external identity provider, or an
      // in-progress callback when the worker wakes. It does not authenticate
      // the transaction; the owned tab/rule and callback state do that.
      const dnr = api()
      if (!dnr) return false
      const rules = await dnr.getSessionRules()
      const expected = buildCallbackRule(
        pending.tabId,
        browser.runtime.getURL(CALLBACK_PATH),
        pending.redirectUri,
      )
      const rule = rules.find((candidate) => candidate.id === AUTH_RULE_ID)
      if (!rule && browser.webNavigation?.onErrorOccurred) {
        // The trusted navigation-error relay can still receive this exact
        // pending tab's loopback return if Chrome lost the session rule.
        await browser.alarms.create(AUTH_ALARM, { when: pending.expires })
        return true
      }
      if (
        !rule ||
        canonical(rule.action) !== canonical(expected.action) ||
        canonical(rule.condition) !== canonical(expected.condition)
      ) {
        await removeRule()
        return false
      }
      await browser.alarms.create(AUTH_ALARM, { when: pending.expires })
      return true
    },
  }
}
