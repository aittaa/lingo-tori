import { describe, expect, it } from "vitest"
import { stableStringify } from "../stable-json"

describe("stableStringify", () => {
  it("gives the same text whatever order the keys were written in, at every depth", () => {
    expect(stableStringify({ b: { d: 1, c: [{ y: 1, x: 2 }] }, a: 0 })).toBe(
      stableStringify({ a: 0, b: { c: [{ x: 2, y: 1 }], d: 1 } }),
    )
  })

  it("drops undefined properties, as storage does, but keeps null and falsy values", () => {
    expect(stableStringify({ a: undefined, b: null, c: 0, d: "", e: false })).toBe(
      '{"b":null,"c":0,"d":"","e":false}',
    )
    expect(stableStringify({ a: undefined })).toBe(stableStringify({}))
  })

  it("turns what JSON cannot hold into what JSON makes of it", () => {
    expect(stableStringify([undefined, Number.NaN, Infinity, 1])).toBe("[null,null,null,1]")
  })

  it("gives a value that is undefined itself the text of null, so it can always be hashed", () => {
    expect(stableStringify(undefined)).toBe("null")
    expect(typeof stableStringify(() => 1)).toBe("string")
  })

  it("keeps array order", () => {
    expect(stableStringify([2, 1])).not.toBe(stableStringify([1, 2]))
  })

  it("tells values that look alike apart", () => {
    const texts = [{ a: 1 }, { a: "1" }, { a: [1] }, { a: null }, {}, [], null, ""].map((value) =>
      stableStringify(value),
    )

    expect(new Set(texts).size).toBe(texts.length)
  })

  it("does not change the object it is given", () => {
    const value = { b: 2, a: { d: undefined, c: 1 } }

    stableStringify(value)

    expect(Object.keys(value)).toEqual(["b", "a"])
    expect(Object.keys(value.a)).toEqual(["d", "c"])
  })
})
