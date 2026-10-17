// The BYOS invoker's read of the stored config.
//
// The invoker used to read `local:config` straight from storage. With a stored config that cannot
// be validated that threw a TypeError (when the broken part is what it reads) or ran the user's raw
// BYOS provider (when the broken part is somewhere else) while every validated reader saw the
// defaults. It reads through the validated reader now, so an invalid stored config behaves exactly
// like the defaults - the "enable a BYOS model" refusal - and the stored value is left alone.
//
// Real: `setupByos`, the background invoker it installs, `invokeByos`, the storage helpers and the
// schema. Mocked: the BYOS service (the network), its vault and its auth transport.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { configSchema } from "@/types/config/config"
import {
  corruptConfig,
  CURRENT_META,
  readRawPrimary,
  resetStorage,
  sameRaw,
  seedPrimary,
  validConfig,
} from "@/utils/config/__tests__/preservation-test-kit"

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

const MODEL = "saved-model"
const REQUEST = { model: MODEL, text: "translate me" }
const REFUSAL = "Enable and select a BYOS model in Settings first"

const BYOS_PROVIDER = {
  id: "saved-byos",
  name: "ChatGPT",
  provider: "byos",
  enabled: true,
  model: { model: "use-custom-model", isCustomModel: true, customModel: MODEL },
}

function withByosProvider(config: any) {
  return { ...config, providersConfig: [...config.providersConfig, BYOS_PROVIDER] }
}

/** Invalid in the part this reader reads: `providersConfig` is a string, not a list. */
function invalidWhereTheReaderLooks(): any {
  return { ...validConfig(), providersConfig: "not a list" }
}

/** Invalid in a part this reader never looks at, with the user's own enabled BYOS provider. */
function invalidElsewhere(): any {
  return withByosProvider(corruptConfig())
}

async function invokeThroughTheBackground() {
  vi.resetModules()
  const { setupByos } = await import("../byos")
  const { invokeByos } = await import("@/utils/byos/invoke")
  setupByos()
  return invokeByos(REQUEST)
}

describe("the BYOS invoker's read of the stored config", () => {
  beforeEach(() => {
    resetStorage()
    serviceInvokeMock.mockReset()
    serviceInvokeMock.mockResolvedValue({ text: "translated" })
  })

  it("uses fixtures that fail the schema, and a valid one that does not", () => {
    expect(configSchema.safeParse(invalidWhereTheReaderLooks()).success).toBe(false)
    expect(configSchema.safeParse(invalidElsewhere()).success).toBe(false)
    expect(configSchema.safeParse(withByosProvider(validConfig())).success).toBe(true)
  })

  it("refuses with the 'enable a BYOS model' message, not a TypeError, when the broken part is the one it reads", async () => {
    await seedPrimary(invalidWhereTheReaderLooks(), CURRENT_META)

    await expect(invokeThroughTheBackground()).rejects.toThrow(REFUSAL)

    expect(serviceInvokeMock).not.toHaveBeenCalled()
  })

  it("does not run the user's raw BYOS provider out of a config that fails validation", async () => {
    await seedPrimary(invalidElsewhere(), CURRENT_META)

    await expect(invokeThroughTheBackground()).rejects.toThrow(REFUSAL)

    expect(serviceInvokeMock).not.toHaveBeenCalled()
  })

  it("leaves the stored value alone while it refuses", async () => {
    await seedPrimary(invalidElsewhere(), CURRENT_META)
    const before = await readRawPrimary()

    await invokeThroughTheBackground().catch(() => undefined)

    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
  })

  describe("controls (a control)", () => {
    it("invokes the service for a valid config with an enabled BYOS provider", async () => {
      await seedPrimary(withByosProvider(validConfig()), CURRENT_META)

      await expect(invokeThroughTheBackground()).resolves.toEqual({ text: "translated" })

      expect(serviceInvokeMock).toHaveBeenCalledTimes(1)
    })

    it("refuses the same way when nothing is stored", async () => {
      await expect(invokeThroughTheBackground()).rejects.toThrow(REFUSAL)

      expect(serviceInvokeMock).not.toHaveBeenCalled()
    })
  })
})
