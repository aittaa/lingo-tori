import { expect, it } from "vitest"
import { normalizeTranslationOutput } from "../translation-output-normalization"
it("preserves literal entities returned by configured providers", () => {
  for (const provider of ["openai", "google", "azure", "deepl", "byos"] as const) {
    expect(normalizeTranslationOutput({ provider }, "&amp; &#60; <tag>")).toBe("&amp; &#60; <tag>")
  }
})
