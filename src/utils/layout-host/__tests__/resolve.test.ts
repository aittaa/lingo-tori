import { describe, expect, it } from "vitest"
import { resolveActionLayout } from "../resolve"

describe("legacy layout compatibility", () => {
  it.each([undefined, null, "", "<script>bad()</script>", "{{ Result }}"])(
    "never exposes stored source for execution",
    (layout) => {
      expect(resolveActionLayout({ layout })).toBe("")
    },
  )
})
