import type { SubtitlesFragment } from "../../types"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/message", () => ({ sendMessage: mocks.sendMessage }))

const LOCAL_REF = { kind: "local" as const, config: { id: "openai-default" } as never }

/** `chars` characters of text per fragment, one second apart. */
function makeFragments(count: number, chars: number): SubtitlesFragment[] {
  return Array.from({ length: count }, (_, i) => ({
    text: "x".repeat(chars),
    start: i * 1000,
    end: i * 1000 + 999,
  }))
}

/** Echo each input cue back as simplified VTT so the result length is countable. */
function vttEchoingInput(jsonContent: string): string {
  const cues = JSON.parse(jsonContent) as Array<{ s: number; e: number; t: string }>
  return `WEBVTT\n\n${cues.map((c) => `${c.s} --> ${c.e}\n${c.t}`).join("\n\n")}`
}

describe("aiSegmentBlock oversize handling", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sendMessage.mockImplementation(async (_name: string, data: { jsonContent: string }) =>
      vttEchoingInput(data.jsonContent),
    )
  })

  it("never splits a local provider, which has no prompt cap", async () => {
    const { aiSegmentBlock } = await import("../ai-segmentation")

    await aiSegmentBlock(makeFragments(40, 2000), LOCAL_REF)

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
  })

  it("preserves long fragment content instead of silently truncating it", async () => {
    const { aiSegmentBlock } = await import("../ai-segmentation")
    const fragments = makeFragments(1, 40000)
    expect(await aiSegmentBlock(fragments, LOCAL_REF)).toEqual(fragments)
  })
})
