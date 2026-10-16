// @vitest-environment jsdom
// ASYNC2-02. translationOnly mode asks a DeepLX endpoint, once, whether it keeps the HTML attribute
// markers (the capability probe). A request that finds the probe running waits for it, and only after
// that wait enters `translateTextForPage`, which reads the page-translation session id at ITS entry.
// So a request created under session S1 could be sent under whatever session is current when the
// probe is released: no session at all (after a stop, the request goes out unscoped and nothing can
// cancel it) or S2 (after a stop followed by a new start, the old request joins the new run). The
// same gap exists for the full-HTML retry after a marker failure, which runs after the first
// request's answer has arrived.
//
// What is pinned here: a request is owned by the session that created it. When that session is no
// longer the current one by the time the request would be sent, it is cancelled (the existing
// cancellation error the page modes swallow), the probe is released for the next waiter, and nothing
// reaches the provider. Requests created with no session stay sessionless (node translation, a retry
// after the session ended) and are not adopted by a session that starts later; a live owner's waiter
// still runs, scoped to its own session.
//
// Everything below the transport is production code: request preparation, the probe, the retry,
// `translateTextForPage`, `translateTextCore` and its session gates, the swap planner and the DOM
// cleanup. Only `sendMessage` (the provider boundary), the stored config and the language/size
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
  const id = `probe-owner-deeplx-${++providerSeq}`
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
// goes through the DeepLX probe. The answers below keep the marker, or lose it.
function mount(label: string) {
  const p = document.createElement("p")
  p.innerHTML = `${label} harbor notice <strong class="k-${label}">Vancouver ${label}</strong> opens today.`
  document.body.append(p)
  return { p, label, originalHTML: p.innerHTML }
}
const answer = (label: string) =>
  `${label}港口通知<strong data-rf-attr="0">温哥华</strong>今天开放。`
const answerWithoutMarker = (label: string) => `${label}港口通知<strong>温哥华</strong>今天开放。`

let config: ReturnType<typeof makeDeepLXConfig>
function startRun(paragraph: { p: HTMLElement }, walkId = "walk-1"): void {
  runs.push(translateNodeTranslationOnlyMode([paragraph.p], walkId, config))
}

/** What the manager's stop() does to this frame: end the session (the background then drains it). */
function stopSession(): string | null {
  // The frame that already showed the spinners has been drawn when the user stops.
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
  // A request that was cancelled because its session ended is dropped silently, like one the
  // background drained: the user stopped it, there is nothing to report.
  expect(paragraph.p.querySelector(`.${TRANSLATION_ERROR_CONTAINER_CLASS}`)).toBeNull()
}

function expectTranslated(paragraph: { p: HTMLElement }) {
  flushBatchedOperations()
  expect(paragraph.p.textContent).toContain("港口通知")
}

describe("ASYNC2-02: a request waiting on the DeepLX probe keeps the session that created it", () => {
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

  describe("a stop while the probe is pending", () => {
    it("sends nothing for the stopped session and writes nothing into the page", async () => {
      const s1 = beginPageTranslationSession()
      const a = mount("Alpha")
      const b = mount("Beta")
      startRun(a)
      await waitForEnqueued(1) // A owns the probe: its marker request is at the provider
      expect(enqueued[0]!.data.sessionId).toBe(s1)
      startRun(b)
      await settle()
      expect(enqueued).toHaveLength(1) // B waits on the probe

      stopSession()
      // The background drains A's request when the session is cancelled; A's probe is released.
      enqueued[0]!.reject(new TranslationCancelledError(s1))
      await settle()

      // Nothing goes out unscoped (it could never be cancelled), and nothing goes out for B at all.
      expect(enqueued.filter((entry) => entry.data.sessionId === undefined)).toHaveLength(0)
      expect(sentFor("Beta")).toHaveLength(0)
      expect(enqueued).toHaveLength(1)
      await Promise.allSettled(runs)
      expectNoTranslationOn(a)
      expectNoTranslationOn(b)
    })

    it("does not let the waiter run under a session that started in the meantime", async () => {
      const s1 = beginPageTranslationSession()
      const a = mount("Alpha")
      const b = mount("Beta")
      startRun(a)
      await waitForEnqueued(1)
      startRun(b)
      await settle()

      stopSession()
      const s2 = beginPageTranslationSession()
      enqueued[0]!.reject(new TranslationCancelledError(s1))
      await settle()

      // Not joined to S2, and not unscoped either.
      expect(enqueued.filter((entry) => entry.data.sessionId === s2)).toHaveLength(0)
      expect(sentFor("Beta")).toHaveLength(0)
      await Promise.allSettled(runs)
      expectNoTranslationOn(b)
    })

    it("lets the new session's own request, parked on the same probe, proceed under that session", async () => {
      const s1 = beginPageTranslationSession()
      const a = mount("Alpha")
      const b = mount("Beta")
      startRun(a)
      await waitForEnqueued(1)
      startRun(b)
      await settle()

      stopSession()
      const s2 = beginPageTranslationSession()
      const c = mount("Gamma")
      startRun(c, "walk-2") // S2's own request finds the probe still pending and waits too
      await settle()
      enqueued[0]!.reject(new TranslationCancelledError(s1))

      await waitForEnqueued(2)
      // The stale waiter gave way; S2's request took the probe and is scoped to S2.
      expect(sentFor("Beta")).toHaveLength(0)
      expect(sentFor("Gamma")).toHaveLength(1)
      expect(sentFor("Gamma")[0]!.data.sessionId).toBe(s2)
      sentFor("Gamma")[0]!.resolve(answer("Gamma"))
      await settle()
      expectTranslated(c)
      expectNoTranslationOn(b)
    })
  })

  describe("the full-HTML retry after a marker failure", () => {
    it("is not sent once the session that asked has stopped", async () => {
      const s1 = beginPageTranslationSession()
      const a = mount("Alpha")
      startRun(a)
      await waitForEnqueued(1)
      expect(enqueued[0]!.data.sessionId).toBe(s1)

      stopSession()
      // The answer was already on its way: it comes back without the marker, so the retry would follow.
      enqueued[0]!.resolve(answerWithoutMarker("Alpha"))
      await settle()

      expect(enqueued).toHaveLength(1)
      await Promise.allSettled(runs)
      expectNoTranslationOn(a)
    })

    it("is not adopted by a session that started in the meantime", async () => {
      beginPageTranslationSession()
      const a = mount("Alpha")
      startRun(a)
      await waitForEnqueued(1)

      stopSession()
      const s2 = beginPageTranslationSession()
      enqueued[0]!.resolve(answerWithoutMarker("Alpha"))
      await settle()

      expect(enqueued.filter((entry) => entry.data.sessionId === s2)).toHaveLength(0)
      expect(enqueued).toHaveLength(1)
      await Promise.allSettled(runs)
      expectNoTranslationOn(a)
    })

    it("still goes out, scoped to the same session, while that session is current", async () => {
      const s1 = beginPageTranslationSession()
      const a = mount("Alpha")
      startRun(a)
      await waitForEnqueued(1)

      enqueued[0]!.resolve(answerWithoutMarker("Alpha"))
      await waitForEnqueued(2)

      expect(enqueued[1]!.data.sessionId).toBe(s1)
      enqueued[1]!.resolve("阿尔法港口通知温哥华今天开放。")
      await settle()
      await Promise.allSettled(runs)
      expectTranslated(a)
    })
  })

  describe("intended behaviour is unchanged", () => {
    it("a normal start with no stop: the waiter runs under the session that created it", async () => {
      const s1 = beginPageTranslationSession()
      const a = mount("Alpha")
      const b = mount("Beta")
      startRun(a)
      await waitForEnqueued(1)
      startRun(b)
      await settle()
      expect(enqueued).toHaveLength(1)

      enqueued[0]!.resolve(answer("Alpha")) // the endpoint keeps the markers: supported
      await waitForEnqueued(2)
      expect(sentFor("Beta")[0]!.data.sessionId).toBe(s1)
      sentFor("Beta")[0]!.resolve(answer("Beta"))
      await settle()
      await Promise.allSettled(runs)
      expectTranslated(a)
      expectTranslated(b)
    })

    it("a transient error of the probe owner leaves a live waiter to run, scoped to its own session", async () => {
      const s1 = beginPageTranslationSession()
      const a = mount("Alpha")
      const b = mount("Beta")
      startRun(a)
      await waitForEnqueued(1)
      startRun(b)
      await settle()

      enqueued[0]!.reject(new Error("temporary provider error"))
      await waitForEnqueued(2)

      // The owner's own failure is delivered as before: its error UI is shown.
      flushBatchedOperations()
      expect(a.p.querySelector(`.${TRANSLATION_ERROR_CONTAINER_CLASS}`)).not.toBeNull()
      expect(sentFor("Beta")).toHaveLength(1)
      expect(sentFor("Beta")[0]!.data.sessionId).toBe(s1)
      sentFor("Beta")[0]!.resolve(answer("Beta"))
      await settle()
      expectTranslated(b)
    })

    it("a request created with no session (node translation, a retry after the session ended) stays sessionless", async () => {
      const a = mount("Alpha")
      startRun(a)
      await waitForEnqueued(1)

      expect(enqueued[0]!.data.sessionId).toBeUndefined()
      enqueued[0]!.resolve(answer("Alpha"))
      await settle()
      await Promise.allSettled(runs)
      expectTranslated(a)
    })

    it("a sessionless waiter is not adopted by a session that starts while it waits, and still runs", async () => {
      const a = mount("Alpha")
      const b = mount("Beta")
      startRun(a)
      await waitForEnqueued(1)
      startRun(b)
      await settle()

      const s2 = beginPageTranslationSession()
      enqueued[0]!.reject(new Error("temporary provider error"))
      await waitForEnqueued(2)

      // It was sessionless when it was created, so it is neither cancelled nor joined to S2.
      expect(sentFor("Beta")).toHaveLength(1)
      expect(sentFor("Beta")[0]!.data.sessionId).toBeUndefined()
      expect(sentFor("Beta")[0]!.data.sessionId).not.toBe(s2)
      sentFor("Beta")[0]!.resolve(answer("Beta"))
      await settle()
      expectTranslated(b)
    })
  })
})
