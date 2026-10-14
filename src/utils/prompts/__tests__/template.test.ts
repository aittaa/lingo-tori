import { describe, expect, it } from "vitest"
import { parsePromptTemplate } from "../template"

describe("parsePromptTemplate", () => {
  it("returns the two prompt strings in a fixed key order", () => {
    const parsed = parsePromptTemplate({ prompt: "user {{input}}", systemPrompt: "system" })

    expect(parsed).toEqual({ systemPrompt: "system", prompt: "user {{input}}" })
    expect(Object.keys(parsed!)).toEqual(["systemPrompt", "prompt"])
  })

  it("drops everything else a sender attached", () => {
    expect(
      parsePromptTemplate({ systemPrompt: "s", prompt: "p", id: "x", name: "y", extra: 1 }),
    ).toEqual({ systemPrompt: "s", prompt: "p" })
  })

  it("keeps empty strings, which are valid prompts", () => {
    expect(parsePromptTemplate({ systemPrompt: "", prompt: "" })).toEqual({
      systemPrompt: "",
      prompt: "",
    })
  })

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "system"],
    ["a number", 1],
    ["an array", ["system", "prompt"]],
    ["an empty object", {}],
    ["a missing prompt", { systemPrompt: "s" }],
    ["a missing system prompt", { prompt: "p" }],
    ["a non-string prompt", { systemPrompt: "s", prompt: 1 }],
    ["a non-string system prompt", { systemPrompt: null, prompt: "p" }],
  ])("rejects %s so the background resolves the prompt itself", (_case, value) => {
    expect(parsePromptTemplate(value)).toBeUndefined()
  })
})
