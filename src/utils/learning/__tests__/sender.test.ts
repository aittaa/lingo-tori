import { describe, expect, it } from "vitest"
import { assertLearningSender } from "@/entrypoints/background/learning"
describe("learning message privilege boundary", () => {
  const study = "chrome-extension://own/study.html"
  it("allows extension content saves but limits private actions to the study page", () => {
    expect(() =>
      assertLearningSender({ id: "own", url: "https://example.com" }, "own"),
    ).not.toThrow()
    expect(() =>
      assertLearningSender({ id: "own", url: "https://example.com" }, "own", study),
    ).toThrow(/.+/)
    expect(() => assertLearningSender({ id: "own", url: study }, "own", study)).not.toThrow()
    expect(() => assertLearningSender({ id: "other", url: study }, "own", study)).toThrow(/.+/)
    expect(() =>
      assertLearningSender({ id: "own", url: `${study}?secret=x` }, "own", study),
    ).toThrow(/.+/)
  })
})
