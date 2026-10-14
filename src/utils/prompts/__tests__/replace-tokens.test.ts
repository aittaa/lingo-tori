import { describe, expect, it } from "vitest"
import { replacePromptTokens } from "../replace-tokens"

describe("replacePromptTokens", () => {
  it("replaces every occurrence of a known cell", () => {
    expect(replacePromptTokens("{{a}}-{{b}}-{{a}}", { "{{a}}": "A", "{{b}}": "B" })).toBe("A-B-A")
  })

  it("inserts values literally, including replacement-pattern syntax", () => {
    const value = "$& $$ $` $' $1 $<n>"

    expect(replacePromptTokens("before {{a}} after", { "{{a}}": value })).toBe(
      `before ${value} after`,
    )
  })

  it("does not scan inserted text for further cells, whatever the order", () => {
    const replacements = { "{{a}}": "{{b}}", "{{b}}": "{{a}}" }

    expect(replacePromptTokens("{{a}} {{b}}", replacements)).toBe("{{b}} {{a}}")
  })

  it("allows an empty replacement", () => {
    expect(replacePromptTokens("x{{a}}y", { "{{a}}": "" })).toBe("xy")
  })

  it("leaves unknown and malformed cells untouched", () => {
    const template = "{{c}} {{ a }} {{}} {{a} {{0}} {{constructor}} {{__proto__}} {{toString}}"

    expect(replacePromptTokens(template, { "{{a}}": "A" })).toBe(template)
  })

  it("finds a known cell nested in extra braces, as a literal search would", () => {
    expect(replacePromptTokens("{{{a}}} {{a}}}", { "{{a}}": "A" })).toBe("{A} A}")
  })

  it("returns the template unchanged when there is nothing to replace", () => {
    expect(replacePromptTokens("", { "{{a}}": "A" })).toBe("")
    expect(replacePromptTokens("no cells here", { "{{a}}": "A" })).toBe("no cells here")
    expect(replacePromptTokens("{{a}}", {})).toBe("{{a}}")
  })
})
