import { describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  duplicateSelectionToolbarAction,
  findSelectionToolbarAction,
  getBuiltInDictionaryAction,
  getSelectionToolbarActions,
  replaceSelectionToolbarAction,
  resolveNoteSuggestionAction,
} from "@/utils/custom-actions"

function cloneSelectionToolbar() {
  return structuredClone(DEFAULT_CONFIG.selectionToolbar)
}

describe("selection toolbar built-in actions", () => {
  it("always resolves the built-in actions before custom actions", () => {
    const selectionToolbar = cloneSelectionToolbar()
    const dictionary = getBuiltInDictionaryAction(selectionToolbar)
    selectionToolbar.customActions = [
      {
        ...dictionary,
        id: "custom-action",
        name: "Custom",
      },
    ]

    expect(getSelectionToolbarActions(selectionToolbar).map((action) => action.id)).toEqual([
      "default-dictionary",
      "default-sentence-analysis",
      "custom-action",
    ])
  })

  it("resolves the built-in Sentence Analysis from its stored state", () => {
    const selectionToolbar = cloneSelectionToolbar()
    selectionToolbar.builtInActions.sentenceAnalysis = {
      enabled: false,
      providerId: "openai-default",
    }

    const action = findSelectionToolbarAction(selectionToolbar, "default-sentence-analysis")
    expect(action).toMatchObject({
      id: "default-sentence-analysis",
      enabled: false,
      providerId: "openai-default",
      icon: "streamline-color:search-visual-flat",
    })
    expect(action?.outputSchema.map((field) => field.id)).toEqual([
      "default-sentence-analysis-annotations",
      "default-sentence-analysis-translation",
    ])
    expect(action?.layout).toBe("")
  })

  it("persists only mutable state when replacing the built-in Sentence Analysis", () => {
    const selectionToolbar = cloneSelectionToolbar()
    const action = findSelectionToolbarAction(selectionToolbar, "default-sentence-analysis")!

    const next = replaceSelectionToolbarAction(selectionToolbar, {
      ...action,
      name: "Renamed",
      systemPrompt: "Changed",
      providerId: "openai-default",
      enabled: false,
    })

    expect(next.builtInActions).toEqual({
      dictionary: selectionToolbar.builtInActions.dictionary,
      sentenceAnalysis: {
        enabled: false,
        providerId: "openai-default",
        shortcut: "Alt+Shift+G",
      },
    })
    expect(next.customActions).toBe(selectionToolbar.customActions)
    expect(findSelectionToolbarAction(next, "default-sentence-analysis")).toMatchObject({
      name: action.name,
      systemPrompt: action.systemPrompt,
      providerId: "openai-default",
    })
  })

  it("persists only mutable state when replacing the built-in Dictionary", () => {
    const selectionToolbar = cloneSelectionToolbar()
    const dictionary = getBuiltInDictionaryAction(selectionToolbar)

    const next = replaceSelectionToolbarAction(selectionToolbar, {
      ...dictionary,
      name: "Attempted rename",
      prompt: "Attempted prompt edit",
      enabled: false,
      providerId: "openai-default",
    })

    expect(next.builtInActions.dictionary).toEqual({
      enabled: false,
      providerId: "openai-default",
      shortcut: "Alt+Shift+D",
    })
    expect(getBuiltInDictionaryAction(next)).toMatchObject({
      id: "default-dictionary",
      name: dictionary.name,
      prompt: dictionary.prompt,
      enabled: false,
      providerId: "openai-default",
    })
    expect(next.customActions).toEqual([])
  })

  it("never persists the built-in Dictionary's layout", () => {
    const selectionToolbar = cloneSelectionToolbar()
    const dictionary = getBuiltInDictionaryAction(selectionToolbar)
    expect(dictionary.layout).toEqual(expect.any(String))

    const next = replaceSelectionToolbarAction(selectionToolbar, {
      ...dictionary,
      layout: "<p>Attempted layout edit</p>",
    })

    expect(next.builtInActions.dictionary).not.toHaveProperty("layout")
    expect(getBuiltInDictionaryAction(next).layout).toBe(dictionary.layout)
    expect(next.customActions).toEqual([])
  })

  it("stores a custom action's layout as given", () => {
    const selectionToolbar = cloneSelectionToolbar()
    const custom = {
      ...getBuiltInDictionaryAction(selectionToolbar),
      id: "custom-action",
      name: "Custom",
      layout: "<p>{{ Before }}</p>",
    }
    selectionToolbar.customActions = [custom]

    const next = replaceSelectionToolbarAction(selectionToolbar, {
      ...custom,
      layout: "<p>{{ After }}</p>",
    })

    expect(next.customActions[0]?.layout).toBe("<p>{{ After }}</p>")
  })

  it("copies the layout when duplicating", () => {
    const selectionToolbar = cloneSelectionToolbar()
    const dictionary = getBuiltInDictionaryAction(selectionToolbar)
    const custom = { ...dictionary, id: "custom-action", name: "Custom", layout: "<p>mine</p>" }

    expect(duplicateSelectionToolbarAction(dictionary, [dictionary]).layout).toBe(dictionary.layout)
    expect(duplicateSelectionToolbarAction(custom, [dictionary, custom]).layout).toBe("<p>mine</p>")
  })

  it("copies enabled and provider into an editable action", () => {
    const selectionToolbar = cloneSelectionToolbar()
    selectionToolbar.builtInActions.dictionary = { enabled: false, providerId: "openai-default" }
    const dictionary = getBuiltInDictionaryAction(selectionToolbar)
    const duplicate = duplicateSelectionToolbarAction(dictionary, [
      dictionary,
      { ...dictionary, id: "same-name", name: dictionary.name },
    ])

    // Everything but the key: one key runs one action.
    const { shortcut: _shortcut, ...dictionaryWithoutShortcut } = dictionary
    expect(duplicate).toEqual({
      ...dictionaryWithoutShortcut,
      id: expect.any(String),
      name: `${dictionary.name} 1`,
    })
    expect(duplicate).not.toHaveProperty("shortcut")
    expect(duplicate.id).not.toBe(dictionary.id)
  })

  it("reads a built-in action's key from its state, and its default key without one", () => {
    const selectionToolbar = cloneSelectionToolbar()
    selectionToolbar.builtInActions.dictionary.shortcut = ""
    selectionToolbar.builtInActions.sentenceAnalysis.shortcut = "Alt+Shift+K"

    expect(findSelectionToolbarAction(selectionToolbar, "default-dictionary")?.shortcut).toBe("")
    expect(
      findSelectionToolbarAction(selectionToolbar, "default-sentence-analysis")?.shortcut,
    ).toBe("Alt+Shift+K")
  })

  it("writes back a state without a key without one, until the key changes", () => {
    const selectionToolbar = cloneSelectionToolbar()
    delete selectionToolbar.builtInActions.dictionary.shortcut
    const dictionary = getBuiltInDictionaryAction(selectionToolbar)
    expect(dictionary.shortcut).toBe("Alt+Shift+D")

    const providerChanged = replaceSelectionToolbarAction(selectionToolbar, {
      ...dictionary,
      providerId: "openai-default",
    })
    expect(providerChanged.builtInActions.dictionary).not.toHaveProperty("shortcut")

    const keyChanged = replaceSelectionToolbarAction(selectionToolbar, {
      ...dictionary,
      shortcut: "Alt+Shift+K",
    })
    expect(keyChanged.builtInActions.dictionary.shortcut).toBe("Alt+Shift+K")
  })

  it("resolves the configured Note suggestion action even when it is disabled", () => {
    const selectionToolbar = cloneSelectionToolbar()
    const customAction = {
      ...getBuiltInDictionaryAction(selectionToolbar),
      id: "custom-save-action",
      name: "Custom Save",
      enabled: false,
    }
    selectionToolbar.customActions = [customAction]
    selectionToolbar.noteSuggestion.actionId = customAction.id

    expect(resolveNoteSuggestionAction(selectionToolbar)).toBe(customAction)
  })

  it("fails fast when the configured Note suggestion action violates the config invariant", () => {
    const selectionToolbar = cloneSelectionToolbar()
    selectionToolbar.noteSuggestion.actionId = "deleted-action"

    expect(() => resolveNoteSuggestionAction(selectionToolbar)).toThrow(
      'Note suggestion action "deleted-action" is missing from the validated configuration.',
    )
  })
})
