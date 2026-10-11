import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  getSelectionToolbarItems,
  reorderSelectionToolbarItems,
  setSelectionToolbarItemPinned,
} from "@/utils/selection-toolbar-items"

describe("retained selection toolbar items", () => {
  it("drops retired speech/writing IDs but retains dictionary and translation", () => {
    const toolbar = structuredClone(DEFAULT_CONFIG.selectionToolbar)
    toolbar.order = ["speak", "default-improve-writing", "default-dictionary", "translate"]
    const ids = getSelectionToolbarItems(toolbar).map((item) => item.id)
    expect(ids).toContain("default-dictionary")
    expect(ids).toContain("translate")
    expect(ids).not.toContain("speak")
    expect(ids).not.toContain("default-improve-writing")
    expect(ids.slice(0, 2)).toEqual(["default-dictionary", "translate"])
  })
  it("retains dictionary pinning and ordering", () => {
    const toolbar = structuredClone(DEFAULT_CONFIG.selectionToolbar)
    const reordered = reorderSelectionToolbarItems(toolbar, [
      "default-dictionary",
      "translate",
      "default-sentence-analysis",
    ])
    const unpinned = setSelectionToolbarItemPinned(reordered, "default-dictionary", false)
    const items = getSelectionToolbarItems(unpinned)
    expect(items[0]?.id).toBe("default-dictionary")
    expect(items[0]?.pinned).toBe(false)
    expect(items.find((item) => item.id === "translate")?.enabled).toBe(true)
  })
})
