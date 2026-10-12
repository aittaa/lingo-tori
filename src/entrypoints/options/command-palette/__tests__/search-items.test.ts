import { describe, expect, it } from "vitest"
import { SEARCH_ITEMS } from "../search-items"

describe("settings search feature boundaries", () => {
  it("keeps retained translation and provider settings searchable without a Hub entry", () => {
    expect(SEARCH_ITEMS.some((item) => /translation.?hub/i.test(JSON.stringify(item)))).toBe(false)
    expect(SEARCH_ITEMS.map((item) => item.route)).toEqual(
      expect.arrayContaining(["/api-providers", "/page-translation", "/video-subtitles"]),
    )
    expect(SEARCH_ITEMS.map((item) => item.sectionId)).toEqual(
      expect.arrayContaining([
        "feature-providers",
        "page-translation-shortcut",
        "selection-translation-shortcut",
        "subtitles-toggle-shortcut",
        "selection-action-shortcuts",
      ]),
    )
  })
})
