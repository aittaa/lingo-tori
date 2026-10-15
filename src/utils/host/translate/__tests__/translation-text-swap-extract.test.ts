// @vitest-environment jsdom
// `extractTranslatedText` reads an untrusted provider translation as plain text
// for the translationOnly wrapper fallback. It must be inert (nothing attached,
// nothing executed) and must never hand back something that gets re-parsed.

import { beforeEach, describe, expect, it } from "vitest"
import { extractTranslatedText } from "../dom/translation-text-swap"

const PROBE_KEY = "ltSecurityProbe"
const PROBE = `document.documentElement.dataset.${PROBE_KEY}='1'`

describe("extractTranslatedText", () => {
  beforeEach(() => {
    document.body.replaceChildren()
    delete document.documentElement.dataset[PROBE_KEY]
  })

  it("returns the text of nested inline markup", () => {
    expect(extractTranslatedText("<b>你好</b> 和 <i><u>世界</u></i>", document)).toBe(
      "你好 和 世界",
    )
  })

  it("decodes entities once and never re-parses the result", () => {
    expect(extractTranslatedText("&lt;b&gt;x&lt;/b&gt; &amp; y", document)).toBe("<b>x</b> & y")
    expect(extractTranslatedText("&amp;lt;b&amp;gt;", document)).toBe("&lt;b&gt;")
  })

  it("turns <br> into a line break and drops script, style and comments", () => {
    expect(
      extractTranslatedText(
        "一<br>二<script>alert(1)</script><style>.a{}</style><!-- c -->三<svg><style>.b{}</style></svg>",
        document,
      ),
    ).toBe("一\n二三")
  })

  it("ignores the contents of a nested <template>, which are never rendered", () => {
    expect(
      extractTranslatedText(`<template><img src="x" onerror="${PROBE}"></template>文本`, document),
    ).toBe("文本")
  })

  it("is inert: parsing attaches nothing to the page and runs no handler", async () => {
    const text = extractTranslatedText(
      `<img src="data:," onerror="${PROBE}"><svg onload="${PROBE}"></svg><iframe src="https://evil.example/f"></iframe>文本`,
      document,
    )

    expect(text).toBe("文本")
    expect(document.body.childElementCount).toBe(0)
    for (const element of document.querySelectorAll("*")) {
      element.dispatchEvent(new Event("error"))
      element.dispatchEvent(new Event("load"))
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.documentElement.dataset[PROBE_KEY]).toBeUndefined()
  })

  it("returns an empty string for markup with no text", () => {
    expect(extractTranslatedText(`<img src="data:,"><script>x</script>`, document)).toBe("")
    expect(extractTranslatedText("", document)).toBe("")
  })
})
