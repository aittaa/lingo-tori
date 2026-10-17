import type { Config } from "@/types/config/config"
import { browser } from "wxt/browser"
import { storage } from "#imports"
import { apiUsageFeatureSchema } from "@/utils/api-usage"
import { createApiUsageIdentity } from "@/utils/api-usage-identity"
import { recordApiUsageAttempt } from "@/utils/api-usage-tracking"
import { isByosExtensionUrl } from "@/utils/byos/browser"
import { createByosJobRegistry } from "@/utils/byos/cancellation"
import { installByosBackgroundInvoker } from "@/utils/byos/invoke"
import { onByosMessage } from "@/utils/byos/messages"
import {
  assertByosSender,
  authAttemptIdSchema,
  createByosService,
  invokeSchema,
} from "@/utils/byos/service"
import { createAuthTransport, AUTH_ALARM, CALLBACK_PATH } from "@/utils/byos/transport"
import { createAuthVault } from "@/utils/byos/vault"
import { CONFIG_STORAGE_KEY } from "@/utils/constants/config"
import { dataCategoriesSchema } from "@/utils/firefox-data-consent"
import { resolveModelId } from "@/utils/providers/model-id"
export function setupByos() {
  const service = createByosService(
    createAuthVault(),
    createAuthTransport(),
    browser.runtime.id,
    browser.runtime.getURL(CALLBACK_PATH),
  )
  if (isByosExtensionUrl(browser.runtime.getURL("/")) && browser.webNavigation?.onErrorOccurred) {
    browser.webNavigation.onErrorOccurred.addListener(
      (details) => {
        void service.recoverCallbackNavigation(details).catch(() => {})
      },
      { url: [{ schemes: ["http"], hostEquals: "127.0.0.1", pathEquals: "/auth/callback" }] },
    )
  }
  void service.initialize().catch(() => {})
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTH_ALARM) void service.expire().catch(() => {})
  })
  browser.tabs.onRemoved.addListener((tabId) => {
    void service.cancel(tabId).catch(() => {})
  })
  const privatePage = (sender: { id?: string; url?: string }) =>
    assertByosSender(sender, browser.runtime.id, browser.runtime.getURL("/options.html"))
  const invoke: Parameters<typeof installByosBackgroundInvoker>[0] = async (
    payload,
    signal,
    usageFeature,
    runtime,
  ) => {
    const request = invokeSchema.parse(payload)
    const config = await storage.getItem<Config>(`local:${CONFIG_STORAGE_KEY}`)
    if (
      !config?.providersConfig.some(
        (provider) =>
          provider.provider === "byos" &&
          provider.enabled &&
          resolveModelId(provider.model) === request.model,
      )
    )
      throw new Error("Enable and select a BYOS model in Settings first")
    const feature = apiUsageFeatureSchema.safeParse(usageFeature).data
    const configured = config.providersConfig.find(
      (provider) =>
        provider.provider === "byos" &&
        provider.enabled &&
        resolveModelId(provider.model) === request.model,
    )
    const identity = configured ? createApiUsageIdentity(configured) : undefined
    return service.invoke(
      request,
      signal,
      feature ? () => recordApiUsageAttempt(feature, "byos", identity) : undefined,
      runtime,
    )
  }
  installByosBackgroundInvoker(invoke)
  onByosMessage("lingotoriByosStatus", ({ sender }) => {
    privatePage(sender)
    return service.status()
  })
  onByosMessage("lingotoriByosSession", ({ sender }) => {
    privatePage(sender)
    return service.session()
  })
  onByosMessage("lingotoriByosModels", ({ sender }) => {
    privatePage(sender)
    return service.models()
  })
  onByosMessage("lingotoriByosAuth", async ({ sender, data }) => {
    privatePage(sender)
    return service.authStart(authAttemptIdSchema.parse(data))
  })
  onByosMessage("lingotoriByosCallback", ({ sender, data }) => service.callback(data, sender))
  onByosMessage("lingotoriByosCancelAuth", ({ sender, data }) => {
    privatePage(sender)
    return service.cancelAuth(data)
  })
  onByosMessage("lingotoriByosSignout", ({ sender }) => {
    privatePage(sender)
    return service.signout()
  })
  const jobs = createByosJobRegistry(browser.runtime.id)
  onByosMessage("lingotoriByosCancel", ({ sender, data }) => jobs.cancel(sender, data))
  onByosMessage("lingotoriByosInvoke", ({ sender, data }) =>
    jobs.invoke(sender, data.requestId, (signal) =>
      invoke(data.payload, signal, data.usageFeature, {
        // A malformed list is refused rather than ignored: the categories only ever add checks.
        dataCategories: dataCategoriesSchema.parse(data.dataCategories),
      }),
    ),
  )
}
