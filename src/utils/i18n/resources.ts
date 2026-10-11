/// <reference types="@modyfi/vite-plugin-yaml/modules" />
import type { Resource } from "i18next"
import type { SupportedUiLocale } from "./locales"
import en from "@/locales/en.yml"
import ja from "@/locales/ja.yml"
import ko from "@/locales/ko.yml"

export type { SupportedUiLocale } from "./locales"
export { DEFAULT_UI_LOCALE, SUPPORTED_UI_LOCALES } from "./locales"

interface LocaleTree {
  [key: string]: string | LocaleTree
}

/**
 * Convert WXT-style positional substitutions to i18next interpolation, applied to
 * every string leaf at build time:
 *   - `$$`      → literal `$`   (WXT escape; none currently in the YAML, handled anyway)
 *   - `$1`..`$9`→ `{{0}}`..`{{8}}` (0-indexed to match the facade's array mapping)
 *
 * Intentionally left untouched:
 *   - existing named tokens like `{{targetLanguage}}` (LLM prompt templates; no `$`)
 *   - Chrome context-menu placeholders like `%s`
 */
function convertPlaceholders(value: string): string {
  return value.replace(/\$\$|\$(\d)/g, (_match, digit: string | undefined) =>
    digit === undefined ? "$" : `{{${Number(digit) - 1}}}`,
  )
}

function convertTree(node: LocaleTree): LocaleTree {
  const out: LocaleTree = {}
  for (const [key, val] of Object.entries(node)) {
    out[key] = typeof val === "string" ? convertPlaceholders(val) : convertTree(val)
  }
  return out
}

const rawResources: Record<SupportedUiLocale, LocaleTree> = { en, ko, ja }

/**
 * i18next resource bundle: `{ [locale]: { translation: <nested string tree> } }`.
 * Single default namespace ("translation"); keys are traversed with keySeparator ".".
 */
export const resources: Resource = Object.fromEntries(
  Object.entries(rawResources).map(([lng, tree]) => [lng, { translation: convertTree(tree) }]),
)
