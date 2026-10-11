import type { Config } from "@/types/config/config"
import { browser } from "wxt/browser"
import { storage } from "#imports"
import { createByosJobRegistry } from "@/utils/byos/cancellation"
import { installByosBackgroundInvoker } from "@/utils/byos/invoke"
import { onByosMessage } from "@/utils/byos/messages"
import { createBridgeStore } from "@/utils/byos/persistence"
import { assertByosSender, createByosService, invokeSchema } from "@/utils/byos/service"
import { CONFIG_STORAGE_KEY } from "@/utils/constants/config"
import { resolveModelId } from "@/utils/providers/model-id"
export function setupByos() {
  const origin = browser.runtime.getURL("/").replace(/\/$/, "")
  const service = createByosService(createBridgeStore(), origin)
  const privatePage = (sender: { id?: string; url?: string }) =>
    assertByosSender(sender, browser.runtime.id, browser.runtime.getURL("/options.html"))
  const invoke: Parameters<typeof installByosBackgroundInvoker>[0] = async (payload, signal) => {
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
    return service.invoke(request, signal)
  }
  installByosBackgroundInvoker(invoke)
  onByosMessage("lingotoriByosStatus", ({ sender }) => {
    privatePage(sender)
    return service.status()
  })
  onByosMessage("lingotoriByosConfigure", ({ sender, data }) => {
    privatePage(sender)
    return service.configure(data)
  })
  onByosMessage("lingotoriByosSession", ({ sender }) => {
    privatePage(sender)
    return service.session()
  })
  onByosMessage("lingotoriByosModels", ({ sender }) => {
    privatePage(sender)
    return service.models()
  })
  onByosMessage("lingotoriByosAuth", async ({ sender }) => {
    privatePage(sender)
    const { authorizationUrl } = await service.authStart()
    await browser.tabs.create({ url: authorizationUrl })
  })
  onByosMessage("lingotoriByosSignout", ({ sender }) => {
    privatePage(sender)
    return service.signout()
  })
  const jobs = createByosJobRegistry(browser.runtime.id)
  onByosMessage("lingotoriByosCancel", ({ sender, data }) => jobs.cancel(sender, data))
  onByosMessage("lingotoriByosInvoke", ({ sender, data }) =>
    jobs.invoke(sender, data.requestId, (signal) => invoke(data.payload, signal)),
  )
}
