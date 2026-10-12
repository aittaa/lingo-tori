// @vitest-environment jsdom
import type { Config } from "@/types/config/config"
import { cleanup, render, screen } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { configAtom } from "@/utils/atoms/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { FEATURE_KEYS } from "@/utils/constants/feature-providers"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { getBuiltInDictionaryAction } from "@/utils/custom-actions"
import { getCustomActionProviderRowId, getFeatureProviderRowId } from "@/utils/navigation"
import { FeatureProvidersConfig } from ".."

vi.mock("@/components/providers/theme-provider", () => ({
  useTheme: () => ({ theme: "light" }),
}))

vi.mock("@/components/llm-providers/set-api-key-warning", () => ({
  SetApiKeyWarning: () => null,
}))

afterEach(() => {
  cleanup()
  fakeBrowser.reset()
})

async function renderAt(search: string, edit?: (config: Config) => void) {
  const config = structuredClone(DEFAULT_CONFIG)
  config.providersConfig = [structuredClone(DEFAULT_PROVIDER_CONFIG.openai)]
  config.selectionToolbar.customActions = [
    { ...getBuiltInDictionaryAction(config.selectionToolbar), id: "mine", name: "Mine" },
  ]
  edit?.(config)
  await fakeBrowser.storage.local.set({ [CONFIG_STORAGE_KEY]: config })
  const store = createStore()
  store.set(configAtom, config)
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[`/api-providers${search}`]}>
        <FeatureProvidersConfig />
      </MemoryRouter>
    </Provider>,
  )
}

const selectorIn = (rowId: string) =>
  document.getElementById(rowId)?.querySelector<HTMLElement>('[role="combobox"]') ?? null

describe("feature providers page", () => {
  it("gives every feature and custom action row the id its links point at", async () => {
    await renderAt("")

    for (const featureKey of FEATURE_KEYS) {
      expect(document.getElementById(getFeatureProviderRowId(featureKey))).not.toBeNull()
    }
    expect(document.getElementById(getCustomActionProviderRowId("mine"))).not.toBeNull()
  })

  it("focuses the real selector of the requested feature without opening it", async () => {
    const rowId = getFeatureProviderRowId("videoSubtitles")
    await renderAt(`?section=${rowId}`)

    expect(selectorIn(rowId)).toBeEnabled()
    expect(selectorIn(rowId)).toHaveFocus()
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
  })

  it("focuses the real selector of the requested custom action", async () => {
    const rowId = getCustomActionProviderRowId("mine")
    await renderAt(`?section=${rowId}`)

    expect(selectorIn(rowId)).toHaveFocus()
  })

  it.each([
    [
      "empty",
      (config: Config) => {
        config.providersConfig = []
      },
    ],
    [
      "all disabled",
      (config: Config) => {
        config.providersConfig[0]!.enabled = false
      },
    ],
  ])("focuses the feature title when providers are %s", async (_case, edit) => {
    const rowId = getFeatureProviderRowId("pageTranslation")
    await renderAt(`?section=${rowId}`, edit)

    expect(selectorIn(rowId)).toBeDisabled()
    const title = document.getElementById(rowId)?.querySelector("h3")
    expect(title).toHaveFocus()
    expect(title).toHaveAccessibleName(
      "options.apiProviders.featureProviders.features.pageTranslation",
    )
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
  })

  it("focuses an AI action title when only translation providers exist", async () => {
    const rowId = getCustomActionProviderRowId("mine")
    await renderAt(`?section=${rowId}`, (config) => {
      config.providersConfig = [structuredClone(DEFAULT_PROVIDER_CONFIG.deepl)]
    })

    expect(selectorIn(getFeatureProviderRowId("pageTranslation"))).toBeEnabled()
    expect(selectorIn(rowId)).toBeDisabled()
    const title = document.getElementById(rowId)?.querySelector("h3")
    expect(title).toHaveFocus()
    expect(title).toHaveAccessibleName("Mine")
  })

  it.each(["", "?section=feature-providers", "?section=provider-config", "?section=nowhere"])(
    "moves no focus for a link that is not a feature row (%s)",
    async (search) => {
      await renderAt(search)

      expect(document.body).toHaveFocus()
    },
  )
})
