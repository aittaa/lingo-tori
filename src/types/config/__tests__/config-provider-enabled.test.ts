import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG, createDefaultDictionaryAction } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { configSchema } from "../config"

describe("explicit provider configuration", () => {
  it("accepts an empty local-only profile", () =>
    expect(configSchema.safeParse(DEFAULT_CONFIG).success).toBe(true))
  it("rejects disabled or unknown provider assignments", () => {
    for (const id of ["disabled", "read-frog-free-ai", "missing"]) {
      const config = structuredClone(DEFAULT_CONFIG)
      config.providersConfig = [
        { ...DEFAULT_PROVIDER_CONFIG.openai, id: "disabled", enabled: false },
      ]
      config.pageTranslation.providerId = id
      expect(configSchema.safeParse(config).success).toBe(false)
    }
  })
  it("accepts enabled BYOK assignments and rejects disabled custom actions", () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.providersConfig = [{ ...DEFAULT_PROVIDER_CONFIG.openai, id: "mine", enabled: true }]
    config.pageTranslation.providerId = "mine"
    config.selectionToolbar.customActions = [
      { ...createDefaultDictionaryAction(), id: "custom", providerId: "mine" },
    ]
    expect(configSchema.safeParse(config).success).toBe(true)
    config.providersConfig[0]!.enabled = false
    expect(configSchema.safeParse(config).success).toBe(false)
  })
})
