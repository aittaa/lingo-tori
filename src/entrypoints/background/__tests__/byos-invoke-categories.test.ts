// A ChatGPT request made from a settings page arrives as an internal message. The background
// hands the optional categories it declares (the page URL) to the service, which checks them at the
// dispatch. A malformed list is refused before anything is invoked.
//
// Real: `setupByos` and its invoker, the job registry and the invocation schema. Doubled: the
// message listener registry, the BYOS service behind the invoker, the vault and the tab transport.

import type { LLMProviderConfig } from "@/types/config/provider"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { browser, storage } from "#imports"
import { CONFIG_STORAGE_KEY } from "@/utils/constants/config"
import {
  configWith,
  PROVIDER_ID,
} from "@/utils/content-script/__tests__/provider-snapshot-fixtures"
import { setupByos } from "../byos"

const { handlers, serviceInvoke } = vi.hoisted(() => ({
  handlers: new Map<string, (message: { sender: unknown; data: any }) => Promise<unknown>>(),
  serviceInvoke: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/byos/messages", () => ({
  onByosMessage: (name: string, handler: never) => {
    handlers.set(name, handler)
  },
  sendByosMessage: vi.fn<() => void>(),
}))
vi.mock("@/utils/byos/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/byos/service")>()),
  createByosService: () => ({ initialize: () => Promise.resolve(), invoke: serviceInvoke }),
}))
vi.mock("@/utils/byos/vault", () => ({ createAuthVault: () => ({}) }))
vi.mock("@/utils/byos/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/byos/transport")>()),
  createAuthTransport: () => ({}),
}))

const MODEL = "synthetic-model"
const byosRow: LLMProviderConfig = {
  id: PROVIDER_ID,
  name: "ChatGPT",
  provider: "byos",
  enabled: true,
  model: { model: "use-custom-model", isCustomModel: true, customModel: MODEL },
}

beforeAll(() => {
  setupByos()
})

beforeEach(async () => {
  fakeBrowser.reset()
  serviceInvoke.mockReset()
  serviceInvoke.mockResolvedValue({ text: "done" })
  await storage.setItem(`local:${CONFIG_STORAGE_KEY}`, configWith(byosRow))
})

function invokeMessage(dataCategories: unknown) {
  const handler = handlers.get("lingotoriByosInvoke")!
  return handler({
    sender: {
      id: browser.runtime.id,
      url: `chrome-extension://${browser.runtime.id}/options.html`,
      frameId: 0,
    },
    data: {
      requestId: "0b9f2d1c-3a44-4f6e-9a55-2f1c8e7d6b10",
      payload: { model: MODEL, text: "Hello" },
      usageFeature: "customAction",
      dataCategories,
    },
  })
}

describe("the internal ChatGPT invocation message", () => {
  it("hands the declared categories to the service", async () => {
    await invokeMessage(["browsingActivity"])

    expect(serviceInvoke).toHaveBeenCalledTimes(1)
    expect(serviceInvoke.mock.calls[0]![3]).toEqual({ dataCategories: ["browsingActivity"] })
  })

  it("hands over no category when none is declared", async () => {
    await invokeMessage(undefined)

    expect(serviceInvoke.mock.calls[0]![3]).toEqual({ dataCategories: undefined })
  })

  it.each([[["authenticationInfo"]], [["unknown"]], ["browsingActivity"]])(
    "refuses %j without invoking anything",
    async (malformed) => {
      await expect(invokeMessage(malformed)).rejects.toThrow(/invalid|expected/i)

      expect(serviceInvoke).not.toHaveBeenCalled()
    },
  )
})
