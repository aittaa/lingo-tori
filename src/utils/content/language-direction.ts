import type { LangCodeISO6393 } from "@/lib/languages"
import { ISO6393_TO_6391, RTL_LANG_CODES } from "@/lib/languages"

interface LanguageDirectionAndLang {
  dir: "ltr" | "rtl"
  lang?: string
}

export function getLanguageDirectionAndLang(targetCode: LangCodeISO6393): LanguageDirectionAndLang {
  const dir = RTL_LANG_CODES.includes(targetCode) ? "rtl" : "ltr"
  const lang = ISO6393_TO_6391[targetCode]

  return { dir, lang }
}
