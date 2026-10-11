import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CustomActionLayoutView } from "../custom-action-layout-view"

function render(
  value: Record<string, unknown> | null,
  status: "streaming" | "done" | "error" = "done",
  source = "",
) {
  return renderToStaticMarkup(
    <CustomActionLayoutView
      source={source}
      outputSchema={[{ id: "result", name: "Result", type: "string", description: "" }]}
      value={value}
      status={status}
    />,
  )
}

describe("independent result field cards", () => {
  it("escapes model markup and never interprets legacy layouts or audio controls", () => {
    const html = render(
      { Result: '<img src=x onerror="alert(1)"><script>bad()</script>' },
      "done",
      '<audio autoplay src="remote"></audio>{{ Result }}',
    )
    expect(html).toContain("&lt;img")
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<script")
    expect(html).not.toContain("<audio")
    expect(html).not.toContain("remote")
    expect(html).not.toContain("{{ Result }}")
  })

  it("distinguishes pending fields from partial text, missing completed fields, and explicit null", () => {
    expect(render(null, "streaming")).toContain("…")
    expect(render({}, "streaming")).toContain('aria-busy="true"')
    expect(render({ Result: "partial" }, "streaming")).toContain("partial")
    expect(render({ Result: null }, "streaming")).toContain("—")
    expect(render({}, "done")).toContain("—")
    expect(render({}, "error")).not.toContain("…")
    expect(render({ Result: "" }, "streaming")).not.toContain("…")
  })

  it("preserves zero, false, arrays and objects without rendering them as React children", () => {
    expect(render({ Result: 0 })).toContain(">0</dd>")
    expect(render({ Result: false })).toContain(">false</dd>")
    expect(render({ Result: [0, false, "text"] })).toContain("[\n  0,\n  false,")
    expect(render({ Result: { meaning: "word" } })).toContain(
      "&quot;meaning&quot;: &quot;word&quot;",
    )
  })

  it("ignores inherited result properties and tolerates cyclic malformed values", () => {
    expect(render(Object.create({ Result: "inherited" }))).not.toContain("inherited")
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(render({ Result: cyclic })).toContain("—")
  })

  it("uses schema order and escapes field labels", () => {
    const html = renderToStaticMarkup(
      <CustomActionLayoutView
        outputSchema={[
          { id: "b", name: "<b>second</b>", type: "string", description: "" },
          { id: "a", name: "first", type: "number", description: "" },
        ]}
        value={{ first: 1, "<b>second</b>": "word" }}
        status="done"
      />,
    )
    expect(html.indexOf("&lt;b&gt;second")).toBeLessThan(html.indexOf(">first</dt>"))
    expect(html).not.toContain("<b>")
  })
})
