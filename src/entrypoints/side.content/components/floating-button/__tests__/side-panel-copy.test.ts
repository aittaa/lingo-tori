import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"

const require = createRequire(import.meta.url)
const { load } = createRequire(require.resolve("@modyfi/vite-plugin-yaml"))("js-yaml") as {
  load: (source: string) => { sidePanel?: Record<string, unknown> }
}

const catalogue = (locale: string) =>
  load(readFileSync(new URL(`../../../../../locales/${locale}.yml`, import.meta.url), "utf8"))
    .sidePanel ?? {}

describe("side panel guidance copy", () => {
  it.each(["unsupportedHint", "failedHint"])(
    "%s is written in English, Korean and Japanese",
    (key) => {
      const [en, ko, ja] = ["en", "ko", "ja"].map((locale) => catalogue(locale)[key])

      for (const text of [en, ko, ja]) {
        expect(typeof text).toBe("string")
        expect((text as string).trim().length).toBeGreaterThan(10)
      }
      // Korean and Japanese are translations, not the English sentence copied over.
      expect(ko).not.toBe(en)
      expect(ja).not.toBe(en)
      expect(ko).toMatch(/[가-힣]/)
      expect(ja).toMatch(/[぀-ヿ]/)
    },
  )

  it("the unsupported hint covers closing as well as opening, and points to the panel's own controls", () => {
    // Chrome 116 to 140 can open the panel from the button but has no call to close it.
    expect(catalogue("en").unsupportedHint).toMatch(/open or close/i)
    expect(catalogue("en").unsupportedHint).toMatch(/close button/i)
    expect(catalogue("ko").unsupportedHint).toMatch(/열거나 닫을 수 없/)
    expect(catalogue("ko").unsupportedHint).toMatch(/닫기 버튼/)
    expect(catalogue("ja").unsupportedHint).toMatch(/開閉できません/)
    expect(catalogue("ja").unsupportedHint).toMatch(/閉じるボタン/)
  })

  it("the Firefox sidebar copy is still there", () => {
    for (const locale of ["en", "ko", "ja"]) {
      expect(catalogue(locale).firefoxUserActionHint).toEqual(expect.any(String))
      expect(catalogue(locale).firefoxUserActionHelpUrl).toMatch(
        /^https:\/\/support\.mozilla\.org\//,
      )
    }
  })
})
