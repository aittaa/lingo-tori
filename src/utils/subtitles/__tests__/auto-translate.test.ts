import type { AutoTranslateInput } from "../auto-translate"
import { describe, expect, it } from "vitest"
import { resolveLanguageCodeFromLocale } from "@/utils/content/page-language"
import { decideAutoTranslate } from "../auto-translate"

const foreign: AutoTranslateInput = {
  enabled: true,
  sourceLanguage: "ja",
  myLanguage: "kor",
  manualOff: false,
}

describe("decideAutoTranslate", () => {
  it("starts for a video in a language other than the viewer's", () => {
    expect(decideAutoTranslate(foreign)).toBe("start")
    expect(decideAutoTranslate({ ...foreign, sourceLanguage: "en-US" })).toBe("start")
  })

  it("never starts while the setting is off, whatever else is true", () => {
    expect(decideAutoTranslate({ ...foreign, enabled: false })).toBe("disabled")
    expect(decideAutoTranslate({ ...foreign, enabled: false, manualOff: true })).toBe("disabled")
    expect(decideAutoTranslate({ ...foreign, enabled: false, sourceLanguage: "" })).toBe("disabled")
  })

  it("lets the viewer's switch-off beat a foreign language", () => {
    expect(decideAutoTranslate({ ...foreign, manualOff: true })).toBe("manual-off")
    // Ahead of the language checks too: nothing about the track matters once they said off.
    expect(decideAutoTranslate({ ...foreign, manualOff: true, sourceLanguage: "" })).toBe(
      "manual-off",
    )
    expect(decideAutoTranslate({ ...foreign, manualOff: true, sourceLanguage: "ko" })).toBe(
      "manual-off",
    )
  })

  it.each([
    ["en", "eng"],
    ["en-US", "eng"],
    ["EN_gb", "eng"],
    ["ko", "kor"],
    ["ko-KR", "kor"],
    ["zh-CN", "cmn"],
    ["zh", "cmn"],
    ["zh-TW", "cmn-Hant"],
    ["zh-Hant", "cmn-Hant"],
  ])("holds back a %s track for a viewer reading %s: nothing to translate", (source, mine) => {
    expect(decideAutoTranslate({ ...foreign, sourceLanguage: source, myLanguage: mine })).toBe(
      "same-language",
    )
  })

  it("keeps Simplified and Traditional Chinese apart, as the same-language passthrough does", () => {
    expect(decideAutoTranslate({ ...foreign, sourceLanguage: "zh-TW", myLanguage: "cmn" })).toBe(
      "start",
    )
    expect(
      decideAutoTranslate({ ...foreign, sourceLanguage: "zh-CN", myLanguage: "cmn-Hant" }),
    ).toBe("start")
  })

  it("agrees with the locale resolution the passthrough uses", () => {
    for (const source of ["en", "en-US", "ja", "ko-KR", "zh-TW", "zh-CN", "fr-CA"]) {
      for (const mine of ["eng", "jpn", "kor", "cmn", "cmn-Hant", "fra"]) {
        const sameLanguage = resolveLanguageCodeFromLocale(source) === mine
        expect(decideAutoTranslate({ ...foreign, sourceLanguage: source, myLanguage: mine })).toBe(
          sameLanguage ? "same-language" : "start",
        )
      }
    }
  })

  it.each([[""], [null], [undefined], ["xx"], ["   "]])(
    "holds back a video whose language is %j instead of guessing",
    (sourceLanguage) => {
      expect(decideAutoTranslate({ ...foreign, sourceLanguage })).toBe("unknown-language")
    },
  )

  it.each([[""], [null], [undefined], ["xx"]])(
    "holds back when the viewer's own language is %j",
    (myLanguage) => {
      expect(decideAutoTranslate({ ...foreign, myLanguage })).toBe("unknown-language")
    },
  )
})
