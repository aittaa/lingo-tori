import { afterEach, describe, expect, it, vi } from "vitest"
import { buildSubtitlesCopyText, copySubtitlesText } from "../srt"

afterEach(() => vi.unstubAllGlobals())

describe("subtitle clipboard text", () => {
  it("copies only multilingual dialogue with normalized line breaks in input order", () => {
    expect(
      buildSubtitlesCopyText([
        { text: "  Hello\r\n안녕\rこんにちは  ", start: 3000, end: 4000 },
        { text: "   ", start: 0, end: 1 },
        { text: "First in time, last in input", start: 0, end: 1000 },
      ]),
    ).toBe("Hello\n안녕\nこんにちは\nFirst in time, last in input")
  })

  it("preserves dialogue numbers, time expressions and repeated cues", () => {
    expect(
      buildSubtitlesCopyText([
        { text: "1", start: 1000, end: 2000 },
        { text: "Meet at 12:30. Bring 2 tickets.", start: 2000, end: 3000 },
        { text: "Again.", start: 3000, end: 4000 },
        { text: "Again.", start: 4000, end: 5000 },
      ]),
    ).toBe("1\nMeet at 12:30. Bring 2 tickets.\nAgain.\nAgain.")
  })

  it("does not use timing metadata to alter or discard dialogue", () => {
    expect(
      buildSubtitlesCopyText([
        { text: "Keep this dialogue.", start: Number.NaN, end: Number.POSITIVE_INFINITY },
        { text: "The time is 00:01:02.", start: -5, end: -1 },
      ]),
    ).toBe("Keep this dialogue.\nThe time is 00:01:02.")
    expect(buildSubtitlesCopyText([{ text: " \r\n ", start: 0, end: 1000 }])).toBe("")
  })

  it("invokes the browser write immediately and passes the exact text", async () => {
    const writeText = vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const text = "Hello\nMeet at 12:30."
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
