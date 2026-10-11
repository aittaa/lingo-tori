import { afterEach, describe, expect, it, vi } from "vitest"
import { buildSubtitlesSrtContent, copySubtitlesText } from "../srt"

afterEach(() => vi.unstubAllGlobals())

describe("subtitle clipboard text", () => {
  it("preserves multilingual text and cue timing with normalized line breaks and consecutive numbering", () => {
    expect(
      buildSubtitlesSrtContent([
        { text: "  Hello\r\n안녕\rこんにちは  ", start: 1234.9, end: 3601002 },
        { text: "   ", start: 0, end: 1 },
        { text: "Invalid", start: Number.NaN, end: 5 },
        { text: "Invalid", start: 1, end: Number.POSITIVE_INFINITY },
        { text: "Last", start: -5, end: -1 },
      ]),
    ).toBe(
      "1\n00:00:01,234 --> 01:00:01,002\nHello\n안녕\nこんにちは\n\n2\n00:00:00,000 --> 00:00:00,001\nLast",
    )
  })

  it("invokes the browser write immediately and passes the exact text", async () => {
    const writeText = vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const text = "1\n00:00:00,000 --> 00:00:01,000\nHello"
    const copy = copySubtitlesText(text)
    expect(writeText).toHaveBeenCalledWith(text)
    await copy
  })

  it("does not overwrite the clipboard with empty text", async () => {
    const writeText = vi.fn<(...args: any[]) => any>()
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    await expect(copySubtitlesText(" \n")).rejects.toThrow("No subtitle text")
    expect(writeText).not.toHaveBeenCalled()
  })

  it("reports unavailable clipboard and propagates permission rejections", async () => {
    vi.stubGlobal("navigator", {})
    await expect(copySubtitlesText("text")).rejects.toThrow("Clipboard access is unavailable")
    const denied = new DOMException("Document is not focused", "NotAllowedError")
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn<(...args: any[]) => any>().mockRejectedValue(denied) },
    })
    await expect(copySubtitlesText("text")).rejects.toBe(denied)
  })
})
