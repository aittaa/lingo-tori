import { describe, expect, it } from "vitest"
import { CUSTOM_ACTION_TEMPLATES } from "../custom-action-templates"

describe("structured action templates", () => {
  it("creates dictionary, analysis and blank templates without executable layouts", () => {
    expect(CUSTOM_ACTION_TEMPLATES.map((template) => template.id)).toEqual([
      "dictionary",
      "sentence-analysis",
      "blank",
    ])
    for (const template of CUSTOM_ACTION_TEMPLATES) {
      const action = template.createAction("user-provider")
      expect(action.providerId).toBe("user-provider")
      expect(action.layout).toBe("")
      expect(action.outputSchema.length).toBeGreaterThan(0)
    }
  })
})
