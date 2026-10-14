import { describe, expect, it } from "vitest"
import { Sha256Hex } from "@/utils/hash"
import { getQueueIdentity, isPrivateSender } from "../private-sender"

type SenderArgument = Parameters<typeof isPrivateSender>[0]

describe("isPrivateSender", () => {
  it("is true only when the sender's tab is explicitly incognito", () => {
    // A real browser sender carries far more than the helper reads.
    const browserSender = { tab: { id: 7, incognito: true } }
    expect(isPrivateSender({ tab: { incognito: true } })).toBe(true)
    expect(isPrivateSender(browserSender)).toBe(true)
  })

  it.each([
    ["no sender", undefined],
    ["a sender without a tab (popup, side panel, background)", {}],
    ["a normal tab", { tab: { id: 7, incognito: false } }],
  ])("is false for %s, which keeps today's persistent behaviour", (_label, sender) => {
    expect(isPrivateSender(sender)).toBe(false)
  })

  it("is false for a tab without the incognito field, which keeps today's persistent behaviour", () => {
    // Not a shape the browser's types allow, but an older or unusual message can
    // still arrive without it.
    const senderWithoutFlag = { tab: { id: 7 } } as SenderArgument
    expect(isPrivateSender(senderWithoutFlag)).toBe(false)
  })

  it("does not treat truthy non-boolean values on the wire as private", () => {
    expect(isPrivateSender({ tab: { incognito: "true" as never } })).toBe(false)
    expect(isPrivateSender({ tab: { incognito: 1 as never } })).toBe(false)
  })
})

describe("getQueueIdentity", () => {
  it("returns the key byte-for-byte for a normal sender", () => {
    const hash = Sha256Hex("some text", "provider identity")
    expect(getQueueIdentity(hash, false)).toBe(hash)
  })

  it("moves a private sender's key into a separate, deterministic namespace", () => {
    const hash = Sha256Hex("some text", "provider identity")
    const privateIdentity = getQueueIdentity(hash, true)
    expect(privateIdentity).not.toBe(hash)
    expect(privateIdentity).toMatch(/^[a-f0-9]{64}$/)
    expect(getQueueIdentity(hash, true)).toBe(privateIdentity)
    expect(getQueueIdentity(Sha256Hex("other text"), true)).not.toBe(privateIdentity)
  })

  it("leaves an empty key empty so unkeyed requests never collapse into one another", () => {
    expect(getQueueIdentity("", true)).toBe("")
    expect(getQueueIdentity("", false)).toBe("")
  })
})
