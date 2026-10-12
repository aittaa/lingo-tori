import { describe, expect, it } from "vitest"
import { reconcileModelSelection } from "./model-selection"
describe("BYOS model refresh", () => {
  const models = [{ slug: "A" }, { slug: "B" }]
  it("preserves the saved model when opening the page", () => {
    expect(reconcileModelSelection(models, "", "B")).toBe("B")
  })
  it("preserves an explicit unsaved selection over the saved model", () => {
    expect(reconcileModelSelection(models, "A", "B")).toBe("A")
  })
  it("reconciles removed models and an empty catalog", () => {
    expect(reconcileModelSelection(models, "removed", "B")).toBe("B")
    expect(reconcileModelSelection(models, "removed", "removed")).toBe("A")
    expect(reconcileModelSelection([], "A", "B")).toBe("")
  })
})
