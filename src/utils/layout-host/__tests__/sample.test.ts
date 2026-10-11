import { describe, expect, it } from "vitest"
import { createLayoutSampleData, syncLayoutSampleData } from "../sample"

const fields = [
  { id: "same", name: "Renamed", type: "string" as const, description: "" },
  { id: "new", name: "New", type: "number" as const, description: "" },
]

describe("inert sample compatibility", () => {
  it("retains user samples by field id through renames and removes deleted fields", () => {
    const before = {
      selection: "saved context",
      targetCode: "kor" as const,
      values: { same: "saved text", removed: "old" },
    }
    expect(syncLayoutSampleData(before, fields, "eng")).toEqual({
      selection: "saved context",
      targetCode: "kor",
      values: { same: "saved text", new: "" },
    })
    expect(before.values).toEqual({ same: "saved text", removed: "old" })
  })
  it("creates blank data without templates or external presets", () => {
    expect(createLayoutSampleData(fields, "jpn")).toEqual({
      selection: "",
      targetCode: "jpn",
      values: { same: "", new: "" },
    })
  })
})
