// @vitest-environment jsdom
// SEC3-01. translationOnly mode sends providers a protected HTML request: every attribute that is
// not human-readable text (href, data-*, class, id, style, on*, ...) is taken out and replaced by a
// marker, and put back locally when the translation returns. When the provider's answer broke that
// marker contract, the request used to be sent again as the page's full HTML, attributes included,
// so values the first request deliberately kept off the wire (signed URLs, one-time links, tokens in
// data-*) reached the provider after all. A DeepLX endpoint that does not keep the markers got the
// raw HTML for every later paragraph too.
//
// What is pinned here: across EVERY outbound payload (the first request, whatever follows it, and the
// requests an endpoint known not to keep the markers gets afterwards) no non-translatable attribute
// value leaves the page. Alongside that, so the fix cannot pass by breaking translation: the user
// still gets the translation (or the existing error UI), the page's own elements keep their own
// attributes, OFF restores everything, and the normal protected path is unchanged.
//
// Everything below the provider mock is production code: request preparation, protection and
// restore, the in-place swap planner, the wrapper fallback and the DOM cleanup all run for real.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG as EMPTY_CONFIG } from "@/utils/constants/config"
import {
  CONTENT_WRAPPER_CLASS,
  TRANSLATION_ERROR_CONTAINER_CLASS,
  TRANSLATION_ONLY_ATTRIBUTE,
} from "@/utils/constants/dom-labels"
import { flushBatchedOperations } from "../../../dom/batch-dom"
import { removeAllTranslatedWrapperNodes } from "../../dom/translation-cleanup"
import { HTML_ATTRIBUTE_MARKER_INTEGRITY_ERROR_CODE } from "../../html-attribute-markers"
import { translateNodeTranslationOnlyMode } from "../translation-modes"

const { mockShouldFilterSmallParagraph, mockTranslateTextForPage, mockShouldSkipAsTargetLanguage } =
  vi.hoisted(() => ({
    mockShouldFilterSmallParagraph: vi.fn<(...args: any[]) => any>(),
    mockTranslateTextForPage: vi.fn<(...args: any[]) => any>(),
    mockShouldSkipAsTargetLanguage: vi.fn<(...args: any[]) => any>(),
  }))

vi.mock("@/utils/host/translate/filter-small-paragraph", () => ({
  shouldFilterSmallParagraph: mockShouldFilterSmallParagraph,
}))

vi.mock("@/utils/host/translate/translate-variants", () => ({
  translateTextForPage: mockTranslateTextForPage,
}))

vi.mock("@/utils/host/translate/target-language-skip", () => ({
  shouldSkipAsTargetLanguage: mockShouldSkipAsTargetLanguage,
}))

// A fresh provider per test: the DeepLX attribute-marker probe is module state keyed on the
// provider, and a test that breaks the markers must not flip the answer for the next one.
let providerSeq = 0
function makeOpenAiConfig() {
  const id = `test-openai-${++providerSeq}`
  return {
    ...EMPTY_CONFIG,
    providersConfig: [
      {
        id,
        provider: "openai-compatible" as const,
        enabled: true,
        name: "Test OpenAI-compatible",
        baseURL: `https://example.com/v1/${providerSeq}`,
        model: { model: "use-custom-model" as const, isCustomModel: true, customModel: "m" },
      },
    ],
    pageTranslation: { ...EMPTY_CONFIG.pageTranslation, providerId: id },
  }
}
function makeDeepLXConfig() {
  const id = `test-deeplx-${++providerSeq}`
  return {
    ...EMPTY_CONFIG,
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

// Fake sentinels only. Each one stands for a kind of attribute the protected request keeps local.
const SENTINELS = {
  href: "https://sentinel.invalid/SECRET-HREF?token=SECRET-QUERY",
  data: "SENTINEL-DATA",
  className: "SENTINEL-CLASS",
  id: "SENTINEL-ID",
  style: "SENTINEL-STYLE",
  handler: "SENTINEL-HANDLER",
} as const
// Readable attributes: translated, so part of the first request, and held to the same contract
// by any request that follows it.
const TITLE = "Annual report"
const ARIA_LABEL = "Open the report"

function linkHtml(tag = "") {
  return (
    `Download <a id="${SENTINELS.id}${tag}" class="${SENTINELS.className}" href="${SENTINELS.href}" ` +
    `data-token="${SENTINELS.data}" data-style="${SENTINELS.style}" onclick="${SENTINELS.handler}()" ` +
    `title="${TITLE}" aria-label="${ARIA_LABEL}">the report</a> today.`
  )
}

// What a provider that does keep the markers returns, and what one that is asked again returns.
const ZH_MARKED = `下载<a data-rf-attr="0" title="年度报告" aria-label="打开报告">报告</a>今天。`
const ZH_PLAIN = `下载<a title="年度报告" aria-label="打开报告">报告</a>今天。`

const PROTECTED_ATTRIBUTE_NAMES = ["id", "class", "href", "data-token", "data-style", "onclick"]

function mountParagraph(html: string = linkHtml(), selector = "a") {
  const p = document.createElement("p")
  p.innerHTML = html
  document.body.append(p)
  const element = p.querySelector<HTMLElement>(selector)!
  return {
    p,
    element,
    originalHTML: p.innerHTML,
    originalNodes: [...p.childNodes],
    originalAttributes: Object.fromEntries(
      [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
    ),
  }
}

async function runTranslationOnly(p: HTMLElement, config: any, walkId = "walk-1"): Promise<void> {
  await translateNodeTranslationOnlyMode([p], walkId, config)
  flushBatchedOperations()
}

const payloads = () => mockTranslateTextForPage.mock.calls.map(([text]) => String(text))

/** No attribute value the first request kept local appears in ANY outbound payload. */
function expectNoSentinelEgress(): void {
  const joined = payloads().join("\n=====\n")
  for (const [kind, value] of Object.entries(SENTINELS)) {
    expect(joined, `${kind} sentinel left the page`).not.toContain(value)
  }
  // The query string rides inside the href sentinel; check its pieces on their own as well.
  expect(joined).not.toContain("SECRET-HREF")
  expect(joined).not.toContain("SECRET-QUERY")
}

/**
 * The page's own element keeps every non-translatable attribute it had, whatever the provider did:
 * these values come from the page DOM, never from a provider answer. While a translation is shown
 * in a wrapper the element is displaced, not destroyed; it is back on OFF (`expectOriginalRestored`).
 */
function expectPageKeepsItsAttributes(
  element: HTMLElement,
  originalAttributes: Record<string, string>,
  names: readonly string[] = PROTECTED_ATTRIBUTE_NAMES,
): void {
  for (const name of names) {
    expect(element.getAttribute(name), `page attribute ${name}`).toBe(
      originalAttributes[name] ?? null,
    )
  }
}

function expectOriginalRestored(p: HTMLElement, originalNodes: Node[], originalHTML: string): void {
  removeAllTranslatedWrapperNodes(document)
  expect(p.innerHTML).toBe(originalHTML)
  expect(p.childNodes).toHaveLength(originalNodes.length)
  originalNodes.forEach((node, index) => expect(p.childNodes[index]).toBe(node))
  expect(document.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).toBeNull()
  expect(document.querySelector(`[${TRANSLATION_ONLY_ATTRIBUTE}]`)).toBeNull()
}

/** The wrapper fallback shows plain text: one text node, no element, none of the page's attributes. */
function getTextOnlyWrapper(): HTMLElement {
  const wrappers = document.querySelectorAll<HTMLElement>(`.${CONTENT_WRAPPER_CLASS}`)
  expect(wrappers).toHaveLength(1)
  const wrapper = wrappers[0]!
  expect(wrapper.children).toHaveLength(0)
  expect(wrapper.childNodes).toHaveLength(1)
  expect(wrapper.firstChild?.nodeType).toBe(Node.TEXT_NODE)
  return wrapper
}

const CORRUPTIONS: ReadonlyArray<{ name: string; respond: () => Promise<string> }> = [
  { name: "a marker is missing from the answer", respond: async () => ZH_PLAIN },
  {
    name: "a marker is duplicated in the answer",
    respond: async () =>
      `下载<a data-rf-attr="0" title="年度报告">报告</a><a data-rf-attr="0">重复</a>今天。`,
  },
  {
    name: "the marker moved to a different tag",
    respond: async () => `下载<span data-rf-attr="0" title="年度报告">报告</span>今天。`,
  },
  {
    name: "an unknown marker appears in the answer",
    respond: async () => `下载<a data-rf-attr="7" title="年度报告">报告</a>今天。`,
  },
  {
    name: "the transport reports a marker-integrity failure (the background's own check)",
    respond: () =>
      Promise.reject(
        Object.assign(new Error('Translation is missing HTML attribute marker "0"'), {
          code: HTML_ATTRIBUTE_MARKER_INTEGRITY_ERROR_CODE,
        }),
      ),
  },
]

describe("SEC3-01: a marker-integrity failure never re-sends the attributes the request kept local", () => {
  beforeEach(() => {
    document.body.replaceChildren()
    mockShouldFilterSmallParagraph.mockReset().mockResolvedValue(false)
    mockShouldSkipAsTargetLanguage.mockReset().mockResolvedValue(false)
    mockTranslateTextForPage.mockReset().mockResolvedValue(ZH_PLAIN)
  })

  describe("harness control", () => {
    it("the fixture really carries every sentinel in the page it translates", () => {
      const { p } = mountParagraph()
      for (const value of Object.values(SENTINELS)) expect(p.innerHTML).toContain(value)
    })

    it("the first, protected request keeps every sentinel local and keeps the readable attributes", async () => {
      mockTranslateTextForPage.mockResolvedValue(ZH_MARKED)
      const { p } = mountParagraph()

      await runTranslationOnly(p, makeOpenAiConfig())

      expect(mockTranslateTextForPage).toHaveBeenCalledTimes(1)
      const [request, textFormat] = mockTranslateTextForPage.mock.calls[0]!
      expect(textFormat).toBe("html")
      expect(request).toContain(`data-rf-attr="0"`)
      expect(request).toContain(`title="${TITLE}"`)
      expect(request).toContain(`aria-label="${ARIA_LABEL}"`)
      expectNoSentinelEgress()
    })
  })

  describe("the normal protected path (markers intact) is unchanged", () => {
    it("sends one protected request, applies the translation in place and restores the page", async () => {
      mockTranslateTextForPage.mockResolvedValue(ZH_MARKED)
      const { p, element, originalAttributes, originalHTML, originalNodes } = mountParagraph()

      await runTranslationOnly(p, makeOpenAiConfig())

      expect(mockTranslateTextForPage).toHaveBeenCalledTimes(1)
      expectNoSentinelEgress()
      // In place: the site's own element, every protected attribute, the translated readable ones.
      expect(p.querySelector("a")).toBe(element)
      expectPageKeepsItsAttributes(element, originalAttributes)
      expect(element.getAttribute("title")).toBe("年度报告")
      expect(element.getAttribute("aria-label")).toBe("打开报告")
      expect(p.textContent).toBe("下载报告今天。")
      expect(p).toHaveAttribute(TRANSLATION_ONLY_ATTRIBUTE)
      expect(document.querySelector(`.${TRANSLATION_ERROR_CONTAINER_CLASS}`)).toBeNull()

      expectOriginalRestored(p, originalNodes, originalHTML)
    })
  })

  describe.each(CORRUPTIONS)("provider answer breaks the contract: $name", ({ respond }) => {
    beforeEach(() => {
      mockTranslateTextForPage.mockImplementationOnce(respond).mockResolvedValue(ZH_PLAIN)
    })

    it("no non-translatable attribute value reaches the provider in the first request or any retry", async () => {
      const { p } = mountParagraph()

      await runTranslationOnly(p, makeOpenAiConfig())

      // The failure was seen: the first call carried the markers, and a request followed it.
      expect(payloads()[0]).toContain(`data-rf-attr="0"`)
      expect(payloads().length).toBeGreaterThanOrEqual(2)
      expectNoSentinelEgress()
    })

    it("readable attributes (title, aria-label) keep the first request's contract in every later request", async () => {
      const { p } = mountParagraph()

      await runTranslationOnly(p, makeOpenAiConfig())

      expect(payloads().length).toBeGreaterThanOrEqual(2)
      for (const payload of payloads()) {
        expect(payload).toContain(`title="${TITLE}"`)
        expect(payload).toContain(`aria-label="${ARIA_LABEL}"`)
      }
    })

    it("the follow-up still translates: the text is on the page, nothing of the provider's markup is live, OFF restores everything", async () => {
      const { p, element, originalAttributes, originalHTML, originalNodes } = mountParagraph()

      await runTranslationOnly(p, makeOpenAiConfig())

      // The user gets the translation, not the error UI.
      expect(document.querySelector(`.${TRANSLATION_ERROR_CONTAINER_CLASS}`)).toBeNull()
      // The link carries an href/id, which a marker-less answer cannot prove it is paired with, so
      // the text goes into a wrapper as plain text (the planner's existing fail-closed fallback).
      expect(getTextOnlyWrapper().textContent).toBe("下载报告今天。")
      expect(p.textContent).toBe("下载报告今天。")
      // The page's own element keeps its own attributes (from the page DOM, not from the provider).
      expectPageKeepsItsAttributes(element, originalAttributes)

      expectOriginalRestored(p, originalNodes, originalHTML)
      expect(p.querySelector("a")).toBe(element)
      expectPageKeepsItsAttributes(element, originalAttributes)
      expect(element.getAttribute("title")).toBe(TITLE)
    })

    it("when the follow-up request fails too, the source DOM is kept and the existing error UI is shown", async () => {
      mockTranslateTextForPage.mockReset()
      mockTranslateTextForPage
        .mockImplementationOnce(respond)
        .mockRejectedValue(new Error("Follow-up failed"))
      const { p, element, originalAttributes, originalHTML, originalNodes } = mountParagraph()

      await runTranslationOnly(p, makeOpenAiConfig())

      expectNoSentinelEgress()
      expect(p.textContent).toContain("Download")
      expect(document.querySelector(`.${TRANSLATION_ERROR_CONTAINER_CLASS}`)).not.toBeNull()
      expect(p.querySelector("a")).toBe(element)
      expectPageKeepsItsAttributes(element, originalAttributes)

      expectOriginalRestored(p, originalNodes, originalHTML)
    })

    it("an answer that only repeats the follow-up request is no translation: the page is left alone", async () => {
      mockTranslateTextForPage.mockReset()
      mockTranslateTextForPage
        .mockImplementationOnce(respond)
        .mockImplementation(async (request: string) => request)
      const { p, originalHTML, originalNodes } = mountParagraph()

      await runTranslationOnly(p, makeOpenAiConfig())

      expectNoSentinelEgress()
      expect(document.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).toBeNull()
      expect(document.querySelector(`.${TRANSLATION_ERROR_CONTAINER_CLASS}`)).toBeNull()
      expect(p.innerHTML).toBe(originalHTML)
      originalNodes.forEach((node, index) => expect(p.childNodes[index]).toBe(node))
    })
  })

  describe("the follow-up is applied in place when its answer can be paired with the page's own elements", () => {
    it("keeps the site's element, its class and data-* attributes, and swaps the text and the readable attribute", async () => {
      mockTranslateTextForPage
        .mockResolvedValueOnce(`参观<strong title="年度报告">温哥华</strong>今天。`)
        .mockResolvedValue(`参观<strong title="年度报告">温哥华</strong>今天。`)
      // The first answer lacks the marker; the follow-up answer is the same structure.
      const { p, element, originalAttributes, originalHTML, originalNodes } = mountParagraph(
        `Visit <strong class="${SENTINELS.className}" data-token="${SENTINELS.data}" title="${TITLE}">Vancouver</strong> today.`,
        "strong",
      )

      await runTranslationOnly(p, makeOpenAiConfig())

      expect(payloads()).toHaveLength(2)
      expect(payloads()[0]).toContain(`data-rf-attr="0"`)
      expect(payloads()[1]).not.toContain("data-rf-attr")
      expectNoSentinelEgress()
      expect(document.querySelector(`.${CONTENT_WRAPPER_CLASS}`)).toBeNull()
      expect(p.querySelector("strong")).toBe(element)
      expect(element.isConnected).toBe(true)
      expectPageKeepsItsAttributes(element, originalAttributes, ["class", "data-token"])
      expect(element.getAttribute("title")).toBe("年度报告")
      expect(p.textContent).toBe("参观温哥华今天。")

      expectOriginalRestored(p, originalNodes, originalHTML)
      expect(element.getAttribute("title")).toBe(TITLE)
    })
  })

  describe("a page-owned attribute that already uses the internal marker name", () => {
    it("is not sent in the follow-up, stays on the page's own element, and is back after OFF", async () => {
      mockTranslateTextForPage
        .mockResolvedValueOnce(`参观<strong>温哥华</strong>今天。`)
        .mockResolvedValue(`参观<strong>温哥华</strong>今天。`)
      const { p, element, originalAttributes, originalHTML, originalNodes } = mountParagraph(
        `Visit <strong class="${SENTINELS.className}" data-rf-attr="page-owned">Vancouver</strong> today.`,
        "strong",
      )

      await runTranslationOnly(p, makeOpenAiConfig())

      expect(payloads()).toHaveLength(2)
      // Only the request-side marker of the first request carries the name; the page's own value
      // ("page-owned") is never on the wire, and the follow-up carries no marker at all.
      expect(payloads()[0]).toContain(`data-rf-attr="0"`)
      expect(payloads()[0]).not.toContain("page-owned")
      expect(payloads()[1]).not.toContain("data-rf-attr")
      expect(payloads()[1]).not.toContain("page-owned")
      expectNoSentinelEgress()
      expect(p.querySelector("strong")).toBe(element)
      expectPageKeepsItsAttributes(element, originalAttributes, ["class", "data-rf-attr"])
      expect(p.textContent).toBe("参观温哥华今天。")

      expectOriginalRestored(p, originalNodes, originalHTML)
      expect(element.getAttribute("data-rf-attr")).toBe("page-owned")
    })
  })

  describe("a DeepLX endpoint that does not keep the markers", () => {
    it("neither its first retry nor the paragraphs after it carry the sentinel attributes, and both still translate", async () => {
      const config = makeDeepLXConfig()
      mockTranslateTextForPage.mockResolvedValueOnce(ZH_PLAIN).mockResolvedValue(ZH_PLAIN)
      const first = mountParagraph(linkHtml("-first"))
      await runTranslationOnly(first.p, config, "walk-1")
      const second = mountParagraph(linkHtml("-second"))
      await runTranslationOnly(second.p, config, "walk-2")

      // Probe request (markers), the retry after its failure, then the next paragraph asked straight
      // away without markers: nothing but the readable attributes, in any of them.
      expect(payloads()).toHaveLength(3)
      expect(payloads()[0]).toContain(`data-rf-attr="0"`)
      expect(payloads()[1]).not.toContain("data-rf-attr")
      expect(payloads()[2]).not.toContain("data-rf-attr")
      expectNoSentinelEgress()
      for (const payload of payloads()) expect(payload).toContain(`title="${TITLE}"`)

      // Both paragraphs were translated, and the pages kept their own attributes.
      expect(document.querySelector(`.${TRANSLATION_ERROR_CONTAINER_CLASS}`)).toBeNull()
      const wrappers = document.querySelectorAll<HTMLElement>(`.${CONTENT_WRAPPER_CLASS}`)
      expect([...wrappers].map((wrapper) => wrapper.textContent)).toEqual([
        "下载报告今天。",
        "下载报告今天。",
      ])
      expectPageKeepsItsAttributes(first.element, first.originalAttributes)
      expectPageKeepsItsAttributes(second.element, second.originalAttributes)

      removeAllTranslatedWrapperNodes(document)
      expect(first.p.innerHTML).toBe(first.originalHTML)
      expect(second.p.innerHTML).toBe(second.originalHTML)
    })
  })
})
