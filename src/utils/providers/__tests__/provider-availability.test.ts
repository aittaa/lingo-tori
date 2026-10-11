import { describe, expect, it } from "vitest"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { getUsableProviderIdsForCapability } from "../provider-availability"
describe("provider availability", () => {
  it("does not offer automatic or hosted providers", () => {
    expect(getUsableProviderIdsForCapability("pageTranslation", [])).toEqual([])
  })
  it("offers enabled compatible local providers", () => {
    expect(
      getUsableProviderIdsForCapability("pageTranslation", [
        DEFAULT_PROVIDER_CONFIG.openai,
        { ...DEFAULT_PROVIDER_CONFIG.google, enabled: false },
      ]),
    ).toEqual([DEFAULT_PROVIDER_CONFIG.openai.id])
  })
})
