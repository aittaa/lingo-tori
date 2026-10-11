import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { SUPPORTED_UI_LOCALES } from "@/utils/i18n/locales"

describe("sentence analysis prompt availability", () => {
  for (const locale of SUPPORTED_UI_LOCALES) {
    it(`keeps a structured analysis prompt for ${locale}`, async () => {
      const text = await readFile(
        new URL(`../../../locales/${locale}.yml`, import.meta.url),
        "utf8",
      )
      const section = text.split("        sentenceAnalysis:")[1]?.split("        blank:")[0]

      expect(section).toContain("fieldAnnotations:")
      expect(section).toContain("fieldTranslation:")
    })
  }
})

it("keeps the English system prompt", async () => {
  const text = await readFile(new URL("../../../locales/en.yml", import.meta.url), "utf8")
  expect(text.split("        sentenceAnalysis:")[1]?.split("        blank:")[0]).toContain(
    "systemPrompt:",
  )
})
