import type { SubtitlesFragment } from "../types"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import { sendMessage } from "@/utils/message"

const NEWLINE_PATTERN = /\n/g
const WHITESPACE_PATTERN = /\s+/g
const VTT_TIMESTAMP_PATTERN = /^(\d+)\s*-->\s*(\d+)$/

export function cleanFragmentsForAi(fragments: SubtitlesFragment[]): SubtitlesFragment[] {
  return fragments
    .map((fragment) => ({
      ...fragment,
      text: fragment.text.replace(NEWLINE_PATTERN, " ").replace(WHITESPACE_PATTERN, " ").trim(),
    }))
    .filter((fragment) => fragment.text.length > 0)
}

export function formatFragmentsToJson(fragments: SubtitlesFragment[]): string {
  return JSON.stringify(
    fragments.map((f) => ({
      s: f.start,
      e: f.end,
      t: f.text,
    })),
  )
}

/**
 * Parse simplified VTT content returned from AI to fragments
 * Format:
 * WEBVTT
 *
 * 1000 --> 1500
 * Hello world.
 *
 * 2000 --> 3500
 * This is a sentence.
 */
export function parseSimplifiedVttToFragments(vtt: string): SubtitlesFragment[] {
  const fragments: SubtitlesFragment[] = []
  const lines = vtt.trim().split("\n")

  let lineIndex = 0
  // Skip WEBVTT header
  while (lineIndex < lines.length && !lines[lineIndex]!.includes("-->")) {
    lineIndex++
  }

  while (lineIndex < lines.length) {
    const line = lines[lineIndex]!.trim()

    // Match timestamp line: "1000 --> 1500" (milliseconds format)
    const match = line.match(VTT_TIMESTAMP_PATTERN)
    if (match) {
      const start = Number.parseInt(match[1]!, 10)
      const end = Number.parseInt(match[2]!, 10)

      // Collect text lines
      const textLines: string[] = []
      lineIndex++
      while (
        lineIndex < lines.length &&
        lines[lineIndex]!.trim() !== "" &&
        !lines[lineIndex]!.includes("-->")
      ) {
        textLines.push(lines[lineIndex]!.trim())
        lineIndex++
      }

      if (textLines.length > 0) {
        fragments.push({
          text: textLines.join("\n"),
          start,
          end,
        })
      }
    } else {
      lineIndex++
    }
  }

  return fragments
}

/**
 * Perform AI segmentation on a block of subtitle fragments.
 *
 * `providerRef` is resolved once per session/run by the caller: segmentation
 * runs per look-ahead block, and a hosted ref costs a hostedAi.status round
 * trip to resolve, so resolving here would pay that per block. Both subtitle
 * routes gate on the same hosted feature, so the session's `videoSubtitles`
 * ref serves segmentation as-is; the wider-budget segmentation route is picked
 * in the background by the message handler.
 */
export async function aiSegmentBlock(
  fragments: SubtitlesFragment[],
  providerRef: PromptableProviderRef,
): Promise<SubtitlesFragment[]> {
  if (fragments.length === 0) {
    return fragments
  }

  const cleanedFragments = cleanFragmentsForAi(fragments)

  if (cleanedFragments.length === 0) {
    return fragments
  }

  const jsonContent = formatFragmentsToJson(cleanedFragments)

  const segmentedVtt = await sendMessage("aiSegmentSubtitles", {
    jsonContent,
    providerRef,
  })

  const segmentedFragments = parseSimplifiedVttToFragments(segmentedVtt)

  if (segmentedFragments.length === 0) {
    throw new Error("AI segmentation returned empty result")
  }

  return segmentedFragments
}
