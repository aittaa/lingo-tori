import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { generateChromeMessages, parseMessagesFile, parseMessagesText } from "@wxt-dev/i18n/build"
import { describe, expect, it } from "vitest"

// The build turns every key path of a locale file into a message name of the browser's own
// `_locales/<locale>/messages.json` (path segments joined with "_"). Chrome refuses to load an
// extension that has a name with any character other than [A-Za-z0-9_], and says so only when the
// built extension is installed (Firefox accepts it), so a hyphen in a key (for example one made from
// a stored value such as "invalid-schema") is caught here instead. The names are produced by the
// build's own functions, not by a copy of its rule.
const LOCALES_DIR = fileURLToPath(new URL("../../../locales/", import.meta.url))
const VALID_NAME = /^[A-Za-z0-9_]+$/

function invalidNames(messages: Awaited<ReturnType<typeof parseMessagesFile>>) {
  return Object.keys(generateChromeMessages(messages)).filter((name) => !VALID_NAME.test(name))
}

describe("message names in the locale files", () => {
  const files = readdirSync(LOCALES_DIR).filter((name) => name.endsWith(".yml"))

  it("finds the locale files to check", () => {
    expect(files).toEqual(expect.arrayContaining(["en.yml", "ja.yml", "ko.yml"]))
  })

  it("only has names the browser accepts in an extension's messages", async () => {
    const offenders: Record<string, string[]> = {}
    for (const file of files) {
      for (const name of invalidNames(await parseMessagesFile(`${LOCALES_DIR}${file}`))) {
        offenders[name] = [...(offenders[name] ?? []), file.replace(/\.yml$/, "")]
      }
    }

    expect(offenders).toEqual({})
  })

  it("recognises a name the browser would refuse (a control)", () => {
    const messages = parseMessagesText(
      ["sample:", "  group:", "    bad-name: x", "    good_name: y"].join("\n"),
      "YAML",
    )

    expect(invalidNames(messages)).toEqual(["sample_group_bad-name"])
  })
})
