// @vitest-environment node
//
// The BYOK note about an endpoint secret that LingoTori cannot recognise must say what the setting
// really does: ticking the declaration saves it and makes authentication consent required for that
// provider, and the user then grants the permission with the separate Allow button. Neither the
// checkbox nor a refused request opens a Firefox prompt by itself.

import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const note = readFileSync(path.resolve("docs/byok.md"), "utf8")
const paragraph = note
  .split("\n\n")
  .find((block) => block.includes("LingoTori recognises a credential by its name"))

describe("the BYOK note about a secret LingoTori cannot recognise", () => {
  it("exists", () => {
    expect(paragraph).toBeDefined()
  })

  it("says the declaration makes authentication consent required", () => {
    expect(paragraph).toContain("makes authentication consent required")
  })

  it("tells the user to click the separate Allow button to request it", () => {
    expect(paragraph).toContain("click the separate **Allow** button")
  })

  it("does not promise that Firefox asks by itself", () => {
    expect(paragraph).not.toContain("Firefox then asks first")
    expect(note).not.toContain("so it cannot ask first for those")
  })

  it("says what LingoTori cannot do about an undeclared secret", () => {
    expect(paragraph).toContain("cannot detect or gate an undeclared secret")
  })
})
