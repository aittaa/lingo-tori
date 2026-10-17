import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// The settings service answers messages from this extension only (it checks the sender), and it
// assumes one background that all contexts share. Both rest on the manifest: it must not let web
// pages or other extensions connect (`externally_connectable`), and it must not split the
// background between a regular and an incognito profile (`incognito: "split"`), which would run a
// second queue over the same storage. The manifest is built in `wxt.config.ts`.
const MANIFEST_SOURCE = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "..", "wxt.config.ts"),
  "utf8",
)

const EXTERNALLY_CONNECTABLE = /["']?externally_connectable["']?\s*:/
const INCOGNITO_MODE = /["']?incognito["']?\s*:/

describe("the extension manifest", () => {
  it("reads the manifest source it is supposed to check", () => {
    expect(MANIFEST_SOURCE).toContain("host_permissions")
    expect(MANIFEST_SOURCE).toContain("web_accessible_resources")
  })

  it("does not let web pages or other extensions send messages to the extension", () => {
    expect(MANIFEST_SOURCE).not.toMatch(EXTERNALLY_CONNECTABLE)
  })

  it("does not split the background between a regular and an incognito profile", () => {
    expect(MANIFEST_SOURCE).not.toMatch(INCOGNITO_MODE)
  })

  it("recognises the settings it is looking for", () => {
    const samples = [
      'externally_connectable: { matches: ["*://*.example.com/*"] },',
      '"externally_connectable": { "ids": ["*"] }',
      'incognito: "split",',
      '"incognito": "split"',
    ]

    expect(
      samples.filter(
        (sample) => !EXTERNALLY_CONNECTABLE.test(sample) && !INCOGNITO_MODE.test(sample),
      ),
    ).toEqual([])
  })
})
