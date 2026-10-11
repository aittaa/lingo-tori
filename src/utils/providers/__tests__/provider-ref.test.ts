import { describe, expect, it } from "vitest"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import {
  getProviderCacheIdentity,
  serializeProviderRef,
  canProviderRefGenerateText,
} from "../provider-ref"
import {
  resolveProviderRefForCapability,
  getSelectableProvidersForCapability,
} from "../provider-registry"

describe("BYOK provider references", () => {
  it("preserves all configured settings and the existing cache identity", async () => {
    const config = {
      ...DEFAULT_PROVIDER_CONFIG["openai-compatible"],
      id: "user-custom",
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      model: {
        model: "use-custom-model" as const,
        isCustomModel: true as const,
        customModel: "private-model",
      },
    }
    const resolved = resolveProviderRefForCapability("pageTranslation", [config], config.id)!
    const ref = await serializeProviderRef(resolved)
    expect(ref.config).toBe(config)
    expect(getProviderCacheIdentity(ref)).toBe(JSON.stringify(config))
    expect(canProviderRefGenerateText(ref)).toBe(true)
  })
  it("does not resolve hosted ids or silently fall back", () => {
    expect(resolveProviderRefForCapability("pageTranslation", [], "read-frog-free-ai")).toBeNull()
    expect(getSelectableProvidersForCapability("pageTranslation", [])).toEqual([])
  })
  it("refuses disabled providers", () => {
    const config = { ...DEFAULT_PROVIDER_CONFIG.openai, enabled: false }
    expect(resolveProviderRefForCapability("pageTranslation", [config], config.id)).toBeNull()
  })
})
