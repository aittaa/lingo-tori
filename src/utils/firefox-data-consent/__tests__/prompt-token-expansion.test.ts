// @vitest-environment node
//
// Prompt tokens are expanded in ONE pass over the template the user wrote. A value that is put in
// (the selected text, a paragraph, the page title, the page content, a field description) is
// literal: if it happens to look like a token, it stays text and is not expanded again.
//
// This matters for Firefox's data consent. Whether a run sends the page URL (browsingActivity) is
// decided from the user's templates. If an expanded value could itself be expanded, a page that
// contains the text `{{webUrl}}` would put the address into a request whose templates never asked
// for it, and the run would have declared nothing.
//
// The builders are exercised directly here; the dispatch tests run the same input end to end.

import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { describe, expect, it } from "vitest"
import { buildNoteSuggestionPrompts } from "@/entrypoints/selection.content/selection-toolbar/note-suggestion/prompt"
import {
  buildSelectionToolbarCustomActionSystemPrompt,
  buildStructuredOutputFieldList,
  customActionUsesWebUrl,
  replaceSelectionToolbarCustomActionPromptTokens,
} from "@/utils/custom-action-prompt"

const PAGE_URL = "https://page.example.test/private/path?session=abc123"
const TOKEN = "{{webUrl}}"

const tokens = (
  over: Partial<Parameters<typeof replaceSelectionToolbarCustomActionPromptTokens>[1]> = {},
) => ({
  selection: "some words",
  paragraphs: "some words in a paragraph",
  targetLanguage: "Korean",
  webTitle: "A page",
  webUrl: PAGE_URL,
  webContent: "The page content",
  ...over,
})

describe("a value that looks like a token stays literal", () => {
  it.each([
    ["the selection", "Explain {{selection}}", { selection: TOKEN }, `Explain ${TOKEN}`],
    ["a paragraph", "Context: {{paragraphs}}", { paragraphs: TOKEN }, `Context: ${TOKEN}`],
    ["the page title", "Page: {{webTitle}}", { webTitle: TOKEN }, `Page: ${TOKEN}`],
    ["the page content", "Read: {{webContent}}", { webContent: TOKEN }, `Read: ${TOKEN}`],
    ["the target language", "Into {{targetLanguage}}", { targetLanguage: TOKEN }, `Into ${TOKEN}`],
  ])("%s", (_name, template, values, expected) => {
    const result = replaceSelectionToolbarCustomActionPromptTokens(template, tokens(values))

    expect(result).toBe(expected)
    expect(result).not.toContain(PAGE_URL)
  })

  it("does not expand any token inside another value, in either order", () => {
    const result = replaceSelectionToolbarCustomActionPromptTokens(
      "{{webUrl}} | {{selection}} | {{paragraphs}} | {{webTitle}}",
      tokens({
        selection: "{{paragraphs}}",
        paragraphs: "{{webTitle}}",
        webTitle: "{{selection}}",
        webUrl: "{{webContent}}",
      }),
    )

    expect(result).toBe("{{webContent}} | {{paragraphs}} | {{webTitle}} | {{selection}}")
  })

  it("keeps the URL as typed when the URL itself contains a token", () => {
    const webUrl = "https://page.example.test/?q={{selection}}"

    expect(
      replaceSelectionToolbarCustomActionPromptTokens(
        "{{webUrl}} for {{selection}}",
        tokens({ webUrl }),
      ),
    ).toBe(`${webUrl} for some words`)
  })

  it("keeps a value that looks like a replacement pattern exactly as it is", () => {
    const selection = "cost $& then $' and $` and $1 and $$"

    expect(
      replaceSelectionToolbarCustomActionPromptTokens(
        "Explain {{selection}}!",
        tokens({ selection }),
      ),
    ).toBe(`Explain ${selection}!`)
  })
})

describe("ordinary literal tokens in the text are preserved", () => {
  it("leaves unknown or malformed braces alone", () => {
    const text = "A {{ name }} and {{unknown}} and {{selection and {selection} and {{{webUrlx}}}"

    expect(replaceSelectionToolbarCustomActionPromptTokens(text, tokens())).toBe(text)
  })

  it("replaces every occurrence of a token in the template", () => {
    expect(
      replaceSelectionToolbarCustomActionPromptTokens(
        "{{selection}}-{{selection}}-{{webTitle}}",
        tokens(),
      ),
    ).toBe("some words-some words-A page")
  })

  it("keeps a token-shaped sentence the user selected, next to a real token", () => {
    const selection = "Type {{webUrl}} to insert the address"
    const result = replaceSelectionToolbarCustomActionPromptTokens(
      "Explain {{selection}} (title: {{webTitle}})",
      tokens({ selection }),
    )

    expect(result).toBe(`Explain ${selection} (title: A page)`)
  })
})

describe("the structured-output contract and the system prompt", () => {
  const hostile = tokens({
    selection: TOKEN,
    paragraphs: TOKEN,
    webTitle: TOKEN,
    webContent: TOKEN,
  })

  it("keeps a token-shaped value literal in a field description", () => {
    const list = buildStructuredOutputFieldList(
      [{ name: "result", type: "string", description: "About {{selection}} on {{webTitle}}" }],
      hostile,
    )

    expect(list).toContain(`About ${TOKEN} on ${TOKEN}`)
    expect(list).not.toContain(PAGE_URL)
  })

  it("keeps a token-shaped value literal in the system prompt and its contract", () => {
    const system = buildSelectionToolbarCustomActionSystemPrompt(
      "Read {{selection}} from {{webContent}}",
      hostile,
      [{ name: "result", type: "string", description: "{{paragraphs}}" }],
    )

    expect(system).toContain(`Read ${TOKEN} from ${TOKEN}`)
    expect(system).not.toContain(PAGE_URL)
  })
})

function actionWith(parts: {
  prompt?: string
  systemPrompt?: string
  description?: string
}): SelectionToolbarCustomAction {
  return {
    id: "synthetic",
    name: "Synthetic",
    enabled: true,
    icon: "tabler:book-2",
    providerId: "provider",
    prompt: parts.prompt ?? "Explain {{selection}}",
    systemPrompt: parts.systemPrompt ?? "You explain words.",
    outputSchema: [
      { id: "f1", name: "result", type: "string", description: parts.description ?? "" },
    ],
  }
}

/** What a custom-action run puts in the provider request, built as the execution plan builds it. */
function rendered(action: SelectionToolbarCustomAction, values: ReturnType<typeof tokens>) {
  return [
    buildSelectionToolbarCustomActionSystemPrompt(action.systemPrompt, values, action.outputSchema),
    replaceSelectionToolbarCustomActionPromptTokens(action.prompt, values),
  ].join("\n")
}

describe("the consent classification follows the expansion", () => {
  const templates = [
    { name: "no URL anywhere", action: actionWith({}) },
    {
      name: "the URL in the prompt",
      action: actionWith({ prompt: `Explain {{selection}} ${TOKEN}` }),
    },
    { name: "the URL in the system prompt", action: actionWith({ systemPrompt: `Page ${TOKEN}` }) },
    { name: "the URL in a field description", action: actionWith({ description: `On ${TOKEN}` }) },
  ]
  const valueSets = [
    { name: "ordinary values", values: tokens() },
    {
      name: "token-shaped values everywhere",
      values: tokens({ selection: TOKEN, paragraphs: TOKEN, webTitle: TOKEN, webContent: TOKEN }),
    },
  ]

  it.each(
    templates.flatMap((t) => valueSets.map((v) => [t.name, v.name, t.action, v.values] as const)),
  )(
    "%s, %s: the URL is in the request exactly when the templates use the token",
    (_template, _values, action, values) => {
      expect(rendered(action, values).includes(PAGE_URL)).toBe(customActionUsesWebUrl(action))
    },
  )
})

describe("the note suggestion builder", () => {
  const hostileInput = {
    selection: TOKEN,
    paragraphs: TOKEN,
    targetLanguage: "Korean",
    webTitle: TOKEN,
    webUrl: PAGE_URL,
    webContent: TOKEN,
  }

  function noteAction(parts: Parameters<typeof actionWith>[0]) {
    return actionWith({
      prompt: "Define {{selection}} in {{paragraphs}} ({{webTitle}})",
      systemPrompt: "Use {{selection}} and {{webContent}}",
      description: "About {{selection}} / {{webTitle}} / {{webContent}}",
      ...parts,
    })
  }

  it("keeps token-shaped values literal in every place the action's templates put them", () => {
    const { systemPrompt, prompt } = buildNoteSuggestionPrompts({
      ...hostileInput,
      action: noteAction({}),
    })

    expect(`${systemPrompt}\n${prompt}`).not.toContain(PAGE_URL)
    expect(prompt).toContain(`Define ${TOKEN} in ${TOKEN} (${TOKEN})`)
    expect(prompt).toContain(`About ${TOKEN} / ${TOKEN} / ${TOKEN}`)
  })

  it("does not expand a field description twice", () => {
    const { prompt } = buildNoteSuggestionPrompts({
      ...hostileInput,
      action: noteAction({ prompt: "Define it", systemPrompt: "Explain it" }),
    })
    const fields = prompt.slice(
      prompt.indexOf("## Selected Action Output Fields"),
      prompt.indexOf("## Source Context"),
    )

    expect(fields).not.toContain(PAGE_URL)
    expect(fields).toContain(`About ${TOKEN}`)
  })

  it.each([
    ["no URL anywhere", noteAction({})],
    ["the URL in the prompt", noteAction({ prompt: `Define {{selection}} ${TOKEN}` })],
    ["the URL in the system prompt", noteAction({ systemPrompt: `Page ${TOKEN}` })],
    ["the URL in a field description", noteAction({ description: `On ${TOKEN}` })],
  ])("%s: the URL is in the request exactly when the templates use the token", (_name, action) => {
    const { systemPrompt, prompt } = buildNoteSuggestionPrompts({ ...hostileInput, action })

    expect(`${systemPrompt}\n${prompt}`.includes(PAGE_URL)).toBe(customActionUsesWebUrl(action))
  })
})
