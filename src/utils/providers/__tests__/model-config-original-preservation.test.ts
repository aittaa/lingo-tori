// `getModelById`'s read of the stored config.
//
// It used to read `local:config` straight from storage. With a stored config that cannot be
// validated that threw a TypeError when the broken part is `providersConfig`, and built a model from
// the user's raw provider row when the broken part is somewhere else, while every validated reader
// saw the defaults. It reads through the validated reader now, so an invalid stored config behaves
// like the defaults (a `ProviderSetupError`, "Provider ... not found") and the stored value is left
// alone.
//
// Real: `getModelById`, the provider helpers, the storage helpers and the schema. Mocked: only the
// BYOS model factory, the provider edge (as `model.test.ts` does).

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

vi.mock("@/utils/byos/model", () => ({
  createByosModel: vi.fn<(modelId: string) => { modelId: string; provider: string }>(
    (modelId: string) => ({ modelId, provider: "byos" }),
  ),
}))

const PROVIDER_ID = "saved-byos"

const BYOS_PROVIDER = {
  id: PROVIDER_ID,
  name: "ChatGPT",
  provider: "byos",
  enabled: true,
  model: { model: "use-custom-model", isCustomModel: true, customModel: "saved-model" },
}

function withProvider(config: any) {
  return { ...config, providersConfig: [...config.providersConfig, BYOS_PROVIDER] }
}

/** Invalid in the part this reader reads: `providersConfig` is a string, not a list. */
function invalidWhereTheReaderLooks(): any {
  return { ...validConfig(), providersConfig: "not a list" }
}

/** Invalid in a part this reader never looks at, with the user's own enabled provider. */
function invalidElsewhere(): any {
  return withProvider(corruptConfig())
}

async function getModelByIdFresh() {
  vi.resetModules()
  const { getModelById } = await import("../model")
  return getModelById(PROVIDER_ID)
}

/** Compared by name: the module registry is reset for each call, so the class is not shared. */
async function failureOf(run: () => Promise<unknown>) {
  return run().then(
    () => undefined,
    (error: unknown) => error as Error,
  )
}

describe("getModelById's read of the stored config", () => {
  beforeEach(() => {
    resetStorage()
  })

  it("uses fixtures that fail the schema, and a valid one that does not", () => {
    expect(configSchema.safeParse(invalidWhereTheReaderLooks()).success).toBe(false)
    expect(configSchema.safeParse(invalidElsewhere()).success).toBe(false)
    expect(configSchema.safeParse(withProvider(validConfig())).success).toBe(true)
  })

  it("fails with a ProviderSetupError, not a TypeError, when the broken part is the one it reads", async () => {
    await seedPrimary(invalidWhereTheReaderLooks(), CURRENT_META)

    const failure = await failureOf(getModelByIdFresh)

    expect(failure?.name).toBe("ProviderSetupError")
    expect(failure?.message).toBe(`Provider ${PROVIDER_ID} not found`)
  })

  it("does not build a model from the user's raw provider row out of a config that fails validation", async () => {
    await seedPrimary(invalidElsewhere(), CURRENT_META)

    const failure = await failureOf(getModelByIdFresh)

    expect(failure?.name).toBe("ProviderSetupError")
    expect(failure?.message).toBe(`Provider ${PROVIDER_ID} not found`)
  })

  it("leaves the stored value alone while it refuses", async () => {
    await seedPrimary(invalidElsewhere(), CURRENT_META)
    const before = await readRawPrimary()

    await failureOf(getModelByIdFresh)

    expect(sameRaw(await readRawPrimary(), before)).toBe(true)
  })

  describe("controls (a control)", () => {
    it("builds the model for a valid config that has the provider", async () => {
      await seedPrimary(withProvider(validConfig()), CURRENT_META)

      await expect(getModelByIdFresh()).resolves.toEqual({
        modelId: "saved-model",
        provider: "byos",
      })
    })

    it("fails with a ProviderSetupError when nothing is stored", async () => {
      const failure = await failureOf(getModelByIdFresh)

      expect(failure?.name).toBe("ProviderSetupError")
      expect(failure?.message).toBe("Config not found")
    })
  })
})
