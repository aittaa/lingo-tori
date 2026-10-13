import { describe, expect, it } from "vitest"
import { langCodeISO6393Schema } from "@/lib/languages"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { pickInitialTargetChoice, suggestTargetCodeFromBrowserLocale } from "../suggested-language"

describe("suggestTargetCodeFromBrowserLocale", () => {
  it.each([
    ["en", "eng"],
    ["en-US", "eng"],
    ["ko", "kor"],
    ["ko-KR", "kor"],
    ["ja-JP", "jpn"],
    ["pt-BR", "por"],
    ["es_419", "spa"],
    ["fr-CA", "fra"],
    ["de", "deu"],
    ["id", "ind"],
    ["fil", "tgl"],
    ["no", "nob"],
    // Chrome may hand back a three-letter tag.
    ["yue", "yue"],
    ["haw", "haw"],
    ["KO-kr", "kor"],
  ])("maps %s to %s", (locale, expected) => {
    expect(suggestTargetCodeFromBrowserLocale(locale)).toBe(expected)
  })

  it.each([
    // Simplified is the default for plain Chinese and for mainland regions.
    ["zh", "cmn"],
    ["zh-CN", "cmn"],
    ["zh-SG", "cmn"],
    ["zh-Hans", "cmn"],
    ["zh-Hans-CN", "cmn"],
    // Traditional regions and the Hant script.
    ["zh-TW", "cmn-Hant"],
    ["zh_TW", "cmn-Hant"],
    ["zh-HK", "cmn-Hant"],
    ["zh-MO", "cmn-Hant"],
    ["zh-Hant", "cmn-Hant"],
    ["zh-Hant-TW", "cmn-Hant"],
    // An explicit script outranks a conflicting region.
    ["zh-Hans-TW", "cmn"],
    ["zh-Hant-CN", "cmn-Hant"],
    // Cantonese is its own entry, even under a Traditional region.
    ["zh-yue-HK", "yue"],
  ])("maps the Chinese tag %s to %s", (locale, expected) => {
    expect(suggestTargetCodeFromBrowserLocale(locale)).toBe(expected)
  })

  it.each([null, undefined, "", "   ", "xx", "xx-YY", "und"])("offers nothing for %j", (locale) => {
    expect(suggestTargetCodeFromBrowserLocale(locale)).toBeNull()
  })

  it("only ever returns codes the language picker offers", () => {
    for (const locale of ["en-GB", "zh-TW", "ar-EG", "sr-Latn", "ms-MY", "iw", "in", "nb-NO"]) {
      const code = suggestTargetCodeFromBrowserLocale(locale)
      expect(langCodeISO6393Schema.safeParse(code).success).toBe(true)
    }
  })
})

describe("pickInitialTargetChoice", () => {
  const defaultTarget = DEFAULT_CONFIG.language.targetCode

  it("suggests the browser language over the untouched default", () => {
    expect(
      pickInitialTargetChoice({ currentTargetCode: defaultTarget, browserLocale: "ko-KR" }),
    ).toEqual({ targetCode: "kor", fromBrowserLanguage: true })
  })

  it("keeps the current target when the browser language maps to nothing", () => {
    expect(
      pickInitialTargetChoice({ currentTargetCode: defaultTarget, browserLocale: "xx" }),
    ).toEqual({ targetCode: defaultTarget, fromBrowserLanguage: false })
    expect(
      pickInitialTargetChoice({ currentTargetCode: defaultTarget, browserLocale: null }),
    ).toEqual({ targetCode: defaultTarget, fromBrowserLanguage: false })
  })

  it("keeps a target that was already changed instead of overwriting it from the browser", () => {
    // Set in settings, or saved by an earlier attempt at this question that could not finish.
    expect(pickInitialTargetChoice({ currentTargetCode: "fra", browserLocale: "ko-KR" })).toEqual({
      targetCode: "fra",
      fromBrowserLanguage: false,
    })
  })
})
