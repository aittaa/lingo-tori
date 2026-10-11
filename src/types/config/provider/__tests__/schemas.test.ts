import { describe, expect, it } from "vitest"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import {
  apiProviderConfigItemSchema,
  llmProviderConfigItemSchema,
  providersConfigSchema,
} from "../schemas"

describe("local companion provider schema", () => {
  it("persists BYOS as a configured provider and accepts it for LLM features", () => {
    const provider = DEFAULT_PROVIDER_CONFIG.byos
    expect(providersConfigSchema.parse([provider])).toEqual([provider])
    expect(llmProviderConfigItemSchema.parse(provider)).toEqual(provider)
  })

  it("keeps BYOS out of the API-key editor schema", () => {
    expect(apiProviderConfigItemSchema.safeParse(DEFAULT_PROVIDER_CONFIG.byos).success).toBe(false)
  })

  it.each(["apiKey", "baseURL", "headers"])("rejects extension-owned %s on BYOS", (field) => {
    const value = field === "headers" ? { Authorization: "test-key" } : "test-value"
    expect(
      providersConfigSchema.safeParse([{ ...DEFAULT_PROVIDER_CONFIG.byos, [field]: value }])
        .success,
    ).toBe(false)
  })
})
