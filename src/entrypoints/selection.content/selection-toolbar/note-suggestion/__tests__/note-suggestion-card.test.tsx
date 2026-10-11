// @vitest-environment jsdom
import type { ReactNode } from "react"
import type { NoteSuggestionSessionResult } from "../use-note-suggestion"
import type { Config } from "@/types/config/config"
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"
import { configAtom } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { i18n } from "@/utils/i18n"

const mocks = vi.hoisted(() => ({
  track: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/note-suggestion/analytics", () => ({
  trackNoteSuggestionEvent: (...args: any[]) => mocks.track(...args),
}))

const { NoteSuggestionCard } = await import("../note-suggestion-card")

function wrapper(store: ReturnType<typeof createStore>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>
  }
}

function createAction(
  overrides: Partial<SelectionToolbarCustomAction> = {},
): SelectionToolbarCustomAction {
  return {
    id: "save-action",
    name: "Dictionary",
    enabled: true,
    icon: "tabler:book-2",
    providerId: "unconfigured",
    systemPrompt: "system",
    prompt: "prompt",
    outputSchema: [
      {
        id: "field-term",
        name: "Term",
        type: "string",
        description: "",
      },
      {
        id: "field-definition",
        name: "Definition",
        type: "string",
        description: "",
      },
    ],
    ...overrides,
  }
}

function createSuggestion(
  actionSnapshot: SelectionToolbarCustomAction,
  notes: Array<Record<string, string | number | null>> = [
    { Term: "ephemeral", Definition: "lasting a very short time" },
  ],
): NoteSuggestionSessionResult {
  return {
    sessionKey: "session-1",
    validated: {
      notes,
      summaryFieldName: "Definition",
    },
    actionSnapshot,
    firedAt: 100,
    analyticsProvider: { provider: "openai", backend_kind: "llm" },
  }
}

function createStoreWithAction(action?: SelectionToolbarCustomAction) {
  const store = createStore()
  const config = structuredClone(DEFAULT_CONFIG)
  config.selectionToolbar.customActions = action ? [action] : []
  config.selectionToolbar.noteSuggestion.actionId = action?.id ?? "default-dictionary"
  store.set(configAtom, config)
  return store
}

function renderCard(
  store: ReturnType<typeof createStore>,
  actionSnapshot: SelectionToolbarCustomAction,
  notes?: Array<Record<string, string | number | null>>,
) {
  return render(
    <NoteSuggestionCard
      suggestion={createSuggestion(actionSnapshot, notes)}
      markShownOnce={() => false}
    />,
    { wrapper: wrapper(store) },
  )
}

describe("NoteSuggestionCard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("preserves suggested terms and meanings without unavailable save controls", () => {
    const action = createAction()
    renderCard(createStoreWithAction(action), action, [
      { Term: "ephemeral", Definition: "lasting a very short time" },
      { Term: "serendipity", Definition: "a fortunate discovery" },
    ])
    expect(screen.getByText("ephemeral")).toBeInTheDocument()
    expect(screen.getByText("lasting a very short time")).toBeInTheDocument()
    expect(screen.getByText("serendipity")).toBeInTheDocument()
    expect(screen.getByText("a fortunate discovery")).toBeInTheDocument()
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: i18n.t("noteSuggestion.save") }),
    ).not.toBeInTheDocument()
  })

  it("prefers the designated meaning field over other explanation fields", () => {
    const action = createAction()
    action.outputSchema.splice(1, 0, {
      id: "field-reading",
      name: "Reading",
      type: "string",
      description: "",
    })
    renderCard(createStoreWithAction(action), action, [
      { Term: "猫", Reading: "neko", Definition: "cat" },
    ])
    expect(screen.getByText("猫")).toBeInTheDocument()
    expect(screen.getByText("cat")).toBeInTheDocument()
    expect(screen.queryByText("neko")).not.toBeInTheDocument()
  })

  it("preserves the selected action when toggling Note suggestion", async () => {
    const action = createAction()
    const store = createStoreWithAction(action)
    await storage.setItem("local:config", store.get(configAtom))
    renderCard(store, action)

    fireEvent.click(screen.getByRole("switch"))

    const expectedNoteSuggestion = {
      enabled: !DEFAULT_CONFIG.selectionToolbar.noteSuggestion.enabled,
      actionId: action.id,
      providerId: DEFAULT_CONFIG.selectionToolbar.noteSuggestion.providerId,
    }
    await waitFor(() => {
      expect(store.get(configAtom).selectionToolbar.noteSuggestion).toEqual(expectedNoteSuggestion)
    })
    await waitFor(async () => {
      expect(
        (await storage.getItem<Config>("local:config"))?.selectionToolbar.noteSuggestion,
      ).toEqual(expectedNoteSuggestion)
    })
    await storage.removeItem("local:config")
  })
})
