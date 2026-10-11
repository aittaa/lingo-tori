import { expect, it } from "vitest"
import { providerSupportsTranslationOnlyMode } from "../translation-only-gate"
it("allows retained translation providers", () => {
  expect(providerSupportsTranslationOnlyMode("deeplx")).toBe(true)
  expect(providerSupportsTranslationOnlyMode("google")).toBe(true)
})
