import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  ISO6393_TO_6391,
  LANG_CODE_ISO6393_OPTIONS,
  LANG_CODE_TO_EN_NAME,
  LANG_CODE_TO_LOCALE_NAME,
  LOCALE_TO_ISO6393,
  langCodeISO6393Schema,
  langLevel,
  RTL_LANG_CODES,
} from ".."

describe("local language contracts", () => {
  it("accepts every persisted language from the GPL locale catalog without renaming it", () => {
    const catalog = readFileSync(new URL("../../../locales/en.yml", import.meta.url), "utf8")
      .split("\nlanguages:\n")[1]!
      .split("\nlingotori:\n")[0]!
    const keys = [...catalog.matchAll(/^  ([A-Za-z]+): /gm)].map((match) =>
      match[1] === "cmnHant" ? "cmn-Hant" : match[1],
    )
    expect(LANG_CODE_ISO6393_OPTIONS).toEqual(keys)
    for (const key of keys) expect(langCodeISO6393Schema.parse(key)).toBe(key)
    for (const invalid of ["und", "auto", "vmw", "cmnHant", "en", "", null])
      expect(langCodeISO6393Schema.safeParse(invalid).success).toBe(false)
  })

  it("preserves Chinese script and UI locale distinctions", () => {
    expect(ISO6393_TO_6391.cmn).toBe("zh-CN")
    expect(ISO6393_TO_6391["cmn-Hant"]).toBe("zh-TW")
    expect(LOCALE_TO_ISO6393["zh-CN"]).toBe("cmn")
    expect(LOCALE_TO_ISO6393["zh-TW"]).toBe("cmn-Hant")
    expect(LOCALE_TO_ISO6393.az).toBe("azj")
    expect(LOCALE_TO_ISO6393.no).toBe("nob")
    expect(ISO6393_TO_6391.skr).toBeUndefined()
  })

  it("provides readable labels for every choice including languages unavailable in ICU", () => {
    expect(LANG_CODE_TO_LOCALE_NAME.jpn).toBe("日本語")
    expect(LANG_CODE_TO_EN_NAME["cmn-Hant"]).toBe("Traditional Chinese")
    for (const code of LANG_CODE_ISO6393_OPTIONS) {
      expect(LANG_CODE_TO_LOCALE_NAME[code].length).toBeGreaterThan(0)
      expect(LANG_CODE_TO_LOCALE_NAME[code]).not.toBe(code)
    }
  })

  it("retains RTL for Arabic, Hebrew, Persian and regional Arabic-script languages", () => {
    for (const code of [
      "arb",
      "heb",
      "pes",
      "prs",
      "urd",
      "ckb",
      "skr",
      "pbu",
      "snd",
      "uig",
      "ydd",
      "div",
    ])
      expect(RTL_LANG_CODES).toContain(code)
    expect(RTL_LANG_CODES).not.toContain("eng")
    expect(RTL_LANG_CODES).not.toContain("cmn")
  })

  it("accepts the existing learning-level config values", () => {
    for (const level of ["beginner", "intermediate", "advanced"])
      expect(langLevel.parse(level)).toBe(level)
    expect(langLevel.safeParse("invalid").success).toBe(false)
  })
})
