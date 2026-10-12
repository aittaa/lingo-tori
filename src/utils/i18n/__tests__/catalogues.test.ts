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

// createSentenceAnalysisDefinition in custom-action-templates.ts deliberately
// keeps tested English model instructions in every UI language. Retain these
// existing fallbacks until a separate prompt-language decision is made.
const intentionalFallbackKeys = [
  "options.selectionToolbar.customActions.templates.sentenceAnalysis.systemPrompt",
  "options.selectionToolbar.customActions.templates.sentenceAnalysis.prompt",
]

describe("supported UI catalogues", () => {
  for (const locale of SUPPORTED_UI_LOCALES.filter((locale) => locale !== "en")) {
    it(`${locale} has every non-canonical English key and no extra keys`, () => {
      const keysWithIntentionalFallbacks = new Set([
        ...Object.keys(catalogues[locale]),
        ...intentionalFallbackKeys,
      ])
      expect([...keysWithIntentionalFallbacks].sort()).toEqual(Object.keys(catalogues.en).sort())
    })

    it(`${locale} preserves positional, named, and Chrome placeholders`, () => {
      for (const [key, value] of Object.entries(catalogues.en)) {
        if (intentionalFallbackKeys.includes(key)) continue
        expect(placeholderSignature(catalogues[locale][key] ?? ""), key).toEqual(
          placeholderSignature(value),
        )
      }
    })

    it(`${locale} preserves the canonical sentence-analysis model instructions`, () => {
      for (const key of intentionalFallbackKeys) {
        const effectivePrompt = catalogues[locale][key] ?? catalogues.en[key]
        expect(effectivePrompt, key).toBe(catalogues.en[key])
      }
    })
  }
})
