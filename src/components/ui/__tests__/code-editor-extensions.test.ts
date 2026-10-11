// @vitest-environment jsdom
import { css } from "@codemirror/lang-css"
import { json, jsonParseLinter } from "@codemirror/lang-json"
import { linter, lintGutter } from "@codemirror/lint"
import { EditorState } from "@codemirror/state"
import { color } from "@uiw/codemirror-extensions-color"
import { getDefaultExtensions, EditorState as ReactEditorState } from "@uiw/react-codemirror"
import { describe, expect, it } from "vitest"
import { cssLinter } from "@/utils/css/lint-css"

describe("settings editors share CodeMirror state", () => {
  it("shares state with the React editor", () => expect(ReactEditorState).toBe(EditorState))
  it("resolves JSON syntax and lint extensions", () => {
    expect(() =>
      EditorState.create({
        extensions: [
          ...getDefaultExtensions({ theme: "dark" }),
          json(),
          linter(jsonParseLinter()),
          lintGutter(),
        ],
      }),
    ).not.toThrow()
  })
  it("resolves CSS syntax, color and lint extensions", () => {
    expect(() =>
      EditorState.create({
        extensions: [
          ...getDefaultExtensions({ theme: "light" }),
          color,
          css(),
          cssLinter(),
          lintGutter(),
        ],
      }),
    ).not.toThrow()
  })
})
