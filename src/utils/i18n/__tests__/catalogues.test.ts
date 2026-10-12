import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"
import { SUPPORTED_UI_LOCALES } from "../locales"

interface LocaleTree {
  [key: string]: string | LocaleTree
}

const require = createRequire(import.meta.url)
// Match the parser used by the shipped Vite YAML plugin and the offline audit.
const { load } = createRequire(require.resolve("@modyfi/vite-plugin-yaml"))("js-yaml") as {
  load: (source: string) => LocaleTree
}

function flatten(node: LocaleTree, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(node).flatMap(([key, value]) => {
      const fullKey = prefix ? `${prefix}.${key}` : key
      return typeof value === "string"
        ? [[fullKey, value]]
        : Object.entries(flatten(value, fullKey))
    }),
  )
}

const catalogues = Object.fromEntries(
  SUPPORTED_UI_LOCALES.map((locale) => [
    locale,
    flatten(load(readFileSync(new URL(`../../../locales/${locale}.yml`, import.meta.url), "utf8"))),
  ]),
) as Record<(typeof SUPPORTED_UI_LOCALES)[number], Record<string, string>>

const placeholderSignature = (value: string) =>
  (value.match(/%s|\$\d+|\{\{[^}]+\}\}/g) ?? []).sort()

// The sentence-analysis system/input prompts stay English. Restored locales also
// use the current English dictionary template to preserve its Korean example.
// Restored locales deliberately omit changed/new copy instead of reusing stale
// upstream wording. Keep the reviewed fallback inventory separate from removed Hub keys.
const coverage = JSON.parse(
  readFileSync(new URL("../../../../docs/ui-locale-coverage.json", import.meta.url), "utf8"),
) as {
  restoredLocales: string[]
  canonicalModelKeys: string[]
  dictionaryFallbackKeys: string[]
  changedEnglishKeys: string[]
  newEnglishKeys: string[]
  deferredHubKeys: string[]
  pendingSharedKeys: Record<string, string>
  missingUpstream: Record<string, string[]>
}
const reference = { ...coverage.pendingSharedKeys, ...catalogues.en }

describe("supported UI catalogues", () => {
  for (const locale of SUPPORTED_UI_LOCALES.filter((supportedLocale) => supportedLocale !== "en")) {
    const restored = coverage.restoredLocales.includes(locale)
    const intentionalFallbackKeys = restored
      ? [
          ...coverage.canonicalModelKeys,
          ...coverage.dictionaryFallbackKeys,
          ...coverage.changedEnglishKeys,
          ...coverage.newEnglishKeys,
          ...coverage.deferredHubKeys,
          ...coverage.missingUpstream[locale]!,
        ]
      : coverage.canonicalModelKeys
    const localeReference = restored ? reference : catalogues.en

    it(`${locale} has only documented fallbacks and no unexpected keys`, () => {
      const missing = Object.keys(localeReference).filter((key) => !(key in catalogues[locale]))
      expect(missing.filter((key) => !intentionalFallbackKeys.includes(key))).toEqual([])
      expect(Object.keys(catalogues[locale]).filter((key) => !(key in localeReference))).toEqual([])
      const unexpectedFallbackEntries = restored
        ? intentionalFallbackKeys.filter((key) => key in catalogues[locale])
        : []
      expect(unexpectedFallbackEntries).toEqual([])
    })

    it(`${locale} preserves positional, named, and Chrome placeholders`, () => {
      const mismatches = Object.entries(catalogues[locale])
        .filter(
          ([key, value]) =>
            placeholderSignature(value).join() !==
            placeholderSignature(localeReference[key] ?? "").join(),
        )
        .map(([key]) => key)
      expect(mismatches).toEqual([])
    })

    it(`${locale} preserves the canonical model instructions`, () => {
      const modelKeys = [
        ...coverage.canonicalModelKeys,
        ...(restored ? coverage.dictionaryFallbackKeys : []),
      ]
      const differences = modelKeys.filter(
        (key) => (catalogues[locale][key] ?? catalogues.en[key]) !== catalogues.en[key],
      )
      expect(differences).toEqual([])
    })
  }
})
