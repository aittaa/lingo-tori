// @vitest-environment jsdom
// Integration of SEC3-01 and ASYNC2-02. SEC3-01 gave translationOnly mode an attribute-free request
// (`translateFallbackHtml`) for the case where a provider, or a remembered DeepLX endpoint, could not
// keep the attribute markers. ASYNC2-02 made every request owned by the session that created it, fixed
// when `createPageTranslationRequest` runs and checked just before the request goes out. The two
// changes touch the same call, `translateTextForAction`, whose third argument became the owner: the
// fallback must forward that owner, and still the force flag after it. A fallback that passes the
// force flag where the owner goes loses both: it is neither cancelled when its session has ended nor
// kept off a session that started since, and it no longer bypasses the memory cache when asked to.
//
// Everything below the transport is production code (request preparation, the DeepLX probe, the
// fallback, `translateTextForPage`, `translateTextCore` and its session gates, the swap planner and the
// DOM cleanup). Only `sendMessage` (the provider boundary), the stored config and the language/size
// filters are test doubles; the provider answers are deferred promises the test settles in order.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG as EMPTY_CONFIG } from "@/utils/constants/config"
import {
  CONTENT_WRAPPER_CLASS,
  TRANSLATION_ERROR_CONTAINER_CLASS,
  TRANSLATION_ONLY_ATTRIBUTE,
} from "@/utils/constants/dom-labels"
import { TranslationCancelledError } from "@/utils/request/cancellation"
import { flushBatchedOperations } from "../../../dom/batch-dom"
import { removeAllTranslatedWrapperNodes } from "../../dom/translation-cleanup"
import { beginPageTranslationSession, endPageTranslationSession } from "../../translation-session"
import { translateNodeTranslationOnlyMode } from "../translation-modes"

const { mockSendMessage, mockGetLocalConfig, mockShouldFilterSmallParagraph, mockShouldSkip } =
  vi.hoisted(() => ({
    mockSendMessage: vi.fn<(...args: any[]) => any>(),
    mockGetLocalConfig: vi.fn<(...args: any[]) => any>(),
    mockShouldFilterSmallParagraph: vi.fn<(...args: any[]) => any>(),
    mockShouldSkip: vi.fn<(...args: any[]) => any>(),
  }))

vi.mock("@/utils/message", () => ({ sendMessage: mockSendMessage }))
vi.mock("@/utils/config/storage", () => ({ getLocalConfig: mockGetLocalConfig }))
vi.mock("@/utils/host/translate/filter-small-paragraph", () => ({
  shouldFilterSmallParagraph: mockShouldFilterSmallParagraph,
}))
vi.mock("@/utils/host/translate/target-language-skip", () => ({
  shouldSkipAsTargetLanguage: mockShouldSkip,
}))

// A fresh DeepLX endpoint per test: the capability probe is module state keyed on the provider.
let providerSeq = 0
function makeDeepLXConfig() {
  const id = `fallback-owner-deeplx-${++providerSeq}`
  return {
    ...EMPTY_CONFIG,
    glossary: { ...EMPTY_CONFIG.glossary, enabled: false },
    providersConfig: [
      {
        id,
        provider: "deeplx" as const,
        enabled: true,
        name: "Test DeepLX",
        baseURL: `https://example.com/translate/${providerSeq}`,
      },
    ],
    pageTranslation: { ...EMPTY_CONFIG.pageTranslation, providerId: id },
  }
}

interface Enqueued {
  data: any
  resolve: (translation: string) => void
  reject: (error: unknown) => void
  settled: boolean
}

// The provider boundary: every `enqueueTranslateRequest` waits here until the test settles it.
const enqueued: Enqueued[] = []
const runs: Promise<void>[] = []

const settle = async () => {
  for (let turn = 0; turn < 4; turn++) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
const waitForEnqueued = (count: number) =>
  vi.waitFor(() => expect(enqueued.length).toBeGreaterThanOrEqual(count))
const sentFor = (label: string) => enqueued.filter((entry) => entry.data.text.includes(label))

// Each paragraph carries a class (a protected attribute), so its request is the marker request that
// goes through the DeepLX probe. An answer without the marker sends the paragraph to the fallback.
function mount(label: string) {
  const p = document.createElement("p")
  p.innerHTML = `${label} harbor notice <strong class="k-${label}">Vancouver ${label}</strong> opens today.`
  document.body.append(p)
  return { p, label, originalHTML: p.innerHTML }
}
const answerWithoutMarker = (label: string) => `${label}港口通知<strong>温哥华</strong>今天开放。`
const fallbackAnswer = (label: string) => `${label}港口通知温哥华今天开放。`

let config: ReturnType<typeof makeDeepLXConfig>
function startRun(
  paragraph: { p: HTMLElement },
  { walkId = "walk-1", forceRetranslation = false } = {},
): void {
  runs.push(
    translateNodeTranslationOnlyMode([paragraph.p], walkId, config, false, forceRetranslation),
  )
}

/** What the manager's stop() does to this frame: end the session (the background then drains it). */
function stopSession(): string | null {
  flushBatchedOperations()
  const ended = endPageTranslationSession()
  removeAllTranslatedWrapperNodes(document)
  return ended
}

function expectNoTranslationOn(paragraph: { p: HTMLElement; originalHTML: string }) {
  flushBatchedOperations()
  expect(paragraph.p.innerHTML).toBe(paragraph.originalHTML)
  expect(paragraph.p.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).toBeNull()
  expect(paragraph.p).not.toHaveAttribute(TRANSLATION_ONLY_ATTRIBUTE)
  expect(paragraph.p.querySelector(`.${TRANSLATION_ERROR_CONTAINER_CLASS}`)).toBeNull()
}

function expectTranslated(paragraph: { p: HTMLElement }) {
  flushBatchedOperations()
  expect(paragraph.p.textContent).toContain("港口通知")
}

describe("the attribute-free fallback request is owned by the session that created the paragraph", () => {
  beforeEach(() => {
    document.body.replaceChildren()
    enqueued.length = 0
    runs.length = 0
    config = makeDeepLXConfig()
    mockGetLocalConfig.mockReset().mockResolvedValue(config)
    mockShouldFilterSmallParagraph.mockReset().mockResolvedValue(false)
    mockShouldSkip.mockReset().mockResolvedValue(false)
    mockSendMessage.mockReset().mockImplementation((type: string, data: any) => {
      if (type !== "enqueueTranslateRequest") return Promise.resolve(undefined)
      return new Promise<string>((resolve, reject) => {
        const entry: Enqueued = {
          data,
          settled: false,
          resolve: (translation) => {
            entry.settled = true
            resolve(translation)
          },
          reject: (error) => {
            entry.settled = true
            reject(error)
          },
        }
        enqueued.push(entry)
      })
    })
  })

  afterEach(async () => {
    endPageTranslationSession()
    // Whatever a failing test left waiting at the provider boundary, so its runs can finish.
    for (const entry of enqueued) {
      if (!entry.settled) entry.reject(new TranslationCancelledError("test-cleanup"))
    }
    await Promise.allSettled(runs)
    document.body.replaceChildren()
  })

  describe("a waiter released from the DeepLX probe into the fallback", () => {
    it("is not sent once the session that created it has stopped and another has started", async () => {
      beginPageTranslationSession()
      const a = mount("Alpha")
      const b = mount("Beta")
      startRun(a)
      await waitForEnqueued(1) // A owns the probe
      startRun(b)
      await settle()
      expect(enqueued).toHaveLength(1) // B waits on the probe

      stopSession()
      const s2 = beginPageTranslationSession()
      // The endpoint's answer lost the marker: it is now known not to keep them, B is released into
      // the attribute-free request and A would retry with it too. Both belong to the ended session.
      enqueued[0]!.resolve(answerWithoutMarker("Alpha"))
      await settle()

      expect(sentFor("Beta")).toHaveLength(0)
      expect(enqueued.filter((entry) => entry.data.sessionId === s2)).toHaveLength(0)
      expect(enqueued.filter((entry) => entry.data.sessionId === undefined)).toHaveLength(0)
      expect(enqueued).toHaveLength(1)
      await Promise.allSettled(runs)
      expectNoTranslationOn(a)
      expectNoTranslationOn(b)
    })

    it("still goes out, scoped to its own session, while that session is current", async () => {
      const s1 = beginPageTranslationSession()
      const a = mount("Alpha")
      const b = mount("Beta")
      startRun(a)
      await waitForEnqueued(1)
      startRun(b)
      await settle()

      enqueued[0]!.resolve(answerWithoutMarker("Alpha"))
      await waitForEnqueued(3) // A's own fallback and B's, released by the probe

      for (const label of ["Alpha", "Beta"]) {
        const fallback = sentFor(label).at(-1)!
        expect(fallback.data.sessionId).toBe(s1)
        fallback.resolve(fallbackAnswer(label))
      }
      await settle()
      await Promise.allSettled(runs)
      expectTranslated(a)
      expectTranslated(b)
    })

    it("created with no session, stays sessionless and is not adopted by a session that starts later", async () => {
      const a = mount("Alpha")
      const b = mount("Beta")
      startRun(a)
      await waitForEnqueued(1)
      startRun(b)
      await settle()

      const s2 = beginPageTranslationSession()
      enqueued[0]!.resolve(answerWithoutMarker("Alpha"))
      await waitForEnqueued(3)

      expect(enqueued.filter((entry) => entry.data.sessionId === s2)).toHaveLength(0)
      for (const label of ["Alpha", "Beta"]) {
        expect(sentFor(label).at(-1)!.data.sessionId).toBeUndefined()
      }
    })
  })

  describe("the retry after a marker failure", () => {
    it("carries the force-retranslation flag of the request it repeats", async () => {
      beginPageTranslationSession()
      const a = mount("Alpha")
      startRun(a, { forceRetranslation: true })
      await waitForEnqueued(1)
      expect(enqueued[0]!.data.forceRetranslation).toBe(true)

      enqueued[0]!.resolve(answerWithoutMarker("Alpha"))
      await waitForEnqueued(2)

      expect(enqueued[1]!.data.forceRetranslation).toBe(true)
    })

    it("does not turn the flag on when the request it repeats did not carry it", async () => {
      beginPageTranslationSession()
      const a = mount("Alpha")
      startRun(a)
      await waitForEnqueued(1)

      enqueued[0]!.resolve(answerWithoutMarker("Alpha"))
      await waitForEnqueued(2)

      expect(enqueued[1]!.data.forceRetranslation).toBe(false)
    })
  })
})
