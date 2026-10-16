// A configuration sent with a stream request is not an admission ticket. For a ChatGPT (BYOS)
// provider the background invoker decides, at call time and from the CURRENT stored settings,
// whether the model may be used: an enabled BYOS provider with that model must exist. The
// configuration a caller carries picks the model the request asks for; it never skips that check.
//
// Real: the stream clients and handlers, the model factory, the BYOS model and background
// invoker (`setupByos`), the invocation schema and the storage helpers. Doubled: the port
// transport, and the BYOS service behind the invoker (the network and the credential vault).

import type { LLMProviderConfig } from "@/types/config/provider"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { storage } from "#imports"
import { CONFIG_STORAGE_KEY } from "@/utils/constants/config"
import {
  configWith,
  PROVIDER_ID,
} from "@/utils/content-script/__tests__/provider-snapshot-fixtures"
import { installStreamPortBridge } from "@/utils/content-script/__tests__/stream-port-bridge"
import {
  streamBackgroundStructuredObject,
  streamBackgroundText,
} from "@/utils/content-script/background-stream-client"
import { buildLocalGenerateTextParams } from "@/utils/providers/generate-params"
import { setupByos } from "../byos"

const { serviceInvokeMock } = vi.hoisted(() => ({
  serviceInvokeMock: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/byos/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/byos/service")>()
  return {
    ...actual,
    createByosService: () => ({
      initialize: () => Promise.resolve(),
      invoke: serviceInvokeMock,
    }),
  }
})
vi.mock("@/utils/byos/vault", () => ({ createAuthVault: () => ({}) }))
vi.mock("@/utils/byos/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/byos/transport")>()),
  createAuthTransport: () => ({}),
}))

const ADMISSION_REFUSAL = /Enable and select a BYOS model in Settings first|Enable this provider/

function byosRow(model: string, enabled = true): LLMProviderConfig {
  return {
    id: PROVIDER_ID,
    name: "ChatGPT",
    provider: "byos",
    enabled,
    model: { model: "use-custom-model", isCustomModel: true, customModel: model },
  }
}

async function store(row: LLMProviderConfig) {
  await storage.setItem(`local:${CONFIG_STORAGE_KEY}`, configWith(row))
}

const STREAMS = [
  {
    name: "text stream",
    reply: "translated",
    run: (row: LLMProviderConfig) =>
      streamBackgroundText({
        usageFeature: "selectionTranslation",
        providerKind: "local",
        providerId: PROVIDER_ID,
        providerConfig: row,
        instructions: "Translate to Korean",
        prompt: "Hello",
        ...buildLocalGenerateTextParams(row),
      }),
  },
  {
    name: "structured stream",
    reply: JSON.stringify({ result: "done" }),
    run: (row: LLMProviderConfig) =>
      streamBackgroundStructuredObject({
        usageFeature: "customAction",
        providerId: PROVIDER_ID,
        providerConfig: row,
        instructions: "Explain",
        prompt: "Hello",
        outputSchema: [{ name: "result", type: "string" }],
        ...buildLocalGenerateTextParams(row),
      } as never),
  },
] as const

let bridge: ReturnType<typeof installStreamPortBridge>

// `setupByos` registers its message listeners once per JS context and installs the invoker the
// BYOS model calls; the stored settings it checks against are read per call.
beforeAll(() => {
  setupByos()
})

beforeEach(() => {
  fakeBrowser.reset()
  serviceInvokeMock.mockReset()
  bridge = installStreamPortBridge()
})

afterEach(() => {
  bridge.dispose()
})

describe.each(STREAMS)("$name with a ChatGPT (BYOS) configuration", ({ run, reply }) => {
  beforeEach(() => {
    serviceInvokeMock.mockResolvedValue({ text: reply })
  })

  it("runs the model of the configuration when the stored settings still enable it", async () => {
    await store(byosRow("byos-model-a"))

    await run(byosRow("byos-model-a"))

    expect(serviceInvokeMock).toHaveBeenCalledTimes(1)
    expect(serviceInvokeMock.mock.calls[0]![0]).toMatchObject({ model: "byos-model-a" })
  })

  it("is refused when the provider was disabled in Settings after the configuration was taken", async () => {
    await store(byosRow("byos-model-a", false))

    await expect(run(byosRow("byos-model-a"))).rejects.toThrow(ADMISSION_REFUSAL)
    expect(serviceInvokeMock).not.toHaveBeenCalled()
  })

  it("is refused when Settings now enable a different model: the configuration does not admit its own", async () => {
    await store(byosRow("byos-model-b"))

    await expect(run(byosRow("byos-model-a"))).rejects.toThrow(ADMISSION_REFUSAL)
    expect(serviceInvokeMock).not.toHaveBeenCalled()
  })
})
