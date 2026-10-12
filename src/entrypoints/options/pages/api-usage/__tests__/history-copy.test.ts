import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"

const require = createRequire(import.meta.url)
const { load } = createRequire(require.resolve("@modyfi/vite-plugin-yaml"))("js-yaml") as {
  load: (source: string) => { options: { apiUsage: unknown } }
}
const messages = (node: unknown): string[] =>
  typeof node === "string"
    ? [node]
    : node && typeof node === "object"
      ? Object.values(node).flatMap(messages)
      : []

describe("usage copy", () => {
  it.each(["en", "ko", "ja"])(
    "does not expose transport jargon in %s labels, help or accessible copy",
    (locale) => {
      const catalogue = load(
        readFileSync(new URL(`../../../../../locales/${locale}.yml`, import.meta.url), "utf8"),
      )
      expect(messages(catalogue.options.apiUsage).join("\n")).not.toMatch(/BYOS|BYOK/)
    },
  )
})
