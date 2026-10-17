// @vitest-environment jsdom

// `vitest.setup.ts` replaces the global `TextEncoder` so that, under jsdom, `encode()` returns an
// array that is `instanceof` the test realm's `Uint8Array` (the native encoder returns one from
// Node's realm). The replacement still has to be an encoder: UTF-8 bytes, not one byte per UTF-16
// code unit.
//
// The expected bytes are written out by hand from the UTF-8 definition (RFC 3629), never computed
// by a `TextEncoder`, so they do not depend on the code under test.

import { describe, expect, it } from "vitest"

const CASES = [
  // One byte per character.
  { name: "ASCII", input: "Hello", bytes: [0x48, 0x65, 0x6c, 0x6c, 0x6f] },
  // U+D55C and U+AE00: three bytes each.
  { name: "Korean", input: "한글", bytes: [0xed, 0x95, 0x9c, 0xea, 0xb8, 0x80] },
  // U+1F600 is a surrogate pair in UTF-16 and a single four-byte sequence in UTF-8.
  { name: "emoji (surrogate pair)", input: "😀", bytes: [0xf0, 0x9f, 0x98, 0x80] },
  { name: "empty string", input: "", bytes: [] },
] as const

describe("the TextEncoder that vitest.setup.ts installs", () => {
  it.each(CASES)("encodes $name as UTF-8", ({ input, bytes }) => {
    const encoded = new TextEncoder().encode(input)

    expect(Array.from(encoded)).toEqual(bytes)
  })

  it.each(CASES)("returns a Uint8Array of the test realm for $name", ({ input }) => {
    const encoded = new TextEncoder().encode(input)

    expect(encoded).toBeInstanceOf(Uint8Array)
    expect(encoded.constructor).toBe(Uint8Array)
  })
})
