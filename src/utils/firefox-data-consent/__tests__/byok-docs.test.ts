// @vitest-environment node
//
// The BYOK note about an endpoint secret that LingoTori cannot recognise must say what the setting
// really does: ticking the declaration saves it and makes authentication consent required for that
// provider, and the user then grants the permission with the separate Allow button. Neither the
// checkbox nor a refused request opens a Firefox prompt by itself.
//
// The Firefox sign-in note must also name everything that stops a sign-in that is waiting for the
// permission from opening the sign-in page, including the end of the session by a failed token
// refresh.

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

const firefoxSignIn = readFileSync(path.resolve("docs/byos-firefox.md"), "utf8")
const waiting = firefoxSignIn
  .split(". ")
  .find((sentence) => sentence.includes("while the permission is being read"))

describe("the Firefox sign-in note about a sign-in that waits for the permission", () => {
  it("exists", () => {
    expect(waiting).toBeDefined()
  })

  it("says the sign-in page stays closed when the sign-in is cancelled, replaced or expires", () => {
    expect(waiting).toContain("cancelled, replaced or expires")
    expect(waiting).toContain("does not open the sign-in page")
  })

  it("adds the sign-in whose session is invalidated, with a failed token refresh as the example", () => {
    expect(waiting).toContain("whose session is invalidated")
    expect(waiting).toContain("token refresh that fails for good")
  })
})
