// @vitest-environment jsdom

import type { ReactNode } from "react"
import type { Config } from "@/types/config/config"
import type { APIProviderConfig, ProvidersConfig } from "@/types/config/provider"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { describe, expect, it, vi } from "vitest"
import { configAtom } from "@/utils/atoms/config"
import { createDefaultDictionaryAction, DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { selectedProviderIdAtom } from "../../atoms"
import { ProviderConfigForm } from "../index"

// Keep actual Jotai selection, provider lookup, and deletion fallback helpers.
// Only replace persistence and the form controls unrelated to choosing an editor.
vi.mock("@/utils/atoms/config", async () => {
  const { atom } = await import("jotai")
  const { DEFAULT_CONFIG: defaults } = await import("@/utils/constants/config")
  const state = atom<Config>(structuredClone(defaults))
  return {
    configAtom: state,
    configFieldsAtomMap: {
      providersConfig: atom(
        (get) => get(state).providersConfig,
        async (get, set, providersConfig: ProvidersConfig) => {
          set(state, { ...get(state), providersConfig })
        },
      ),
    },
    writeConfigAtom: atom(null, async (get, set, patch: Partial<Config>) => {
      set(state, { ...get(state), ...patch })
    }),
  }
})

vi.mock("@/utils/atoms/entity-config", async () => {
  const { atom } = await import("jotai")
  return { patchProviderConfigAtom: atom(null, async () => {}) }
})

vi.mock("@/components/form/autosave-navigation", async () => {
  const { atom } = await import("jotai")
  return {
    AutosaveBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
    requestEditorNavigationAtom: atom(
      null,
      async (_get, _set, proceed: () => void | Promise<void>) => {
        await proceed()
        return true
      },
    ),
  }
})

vi.mock("../../provider-editor", async () => {
  const { createContext, useContext } = await import("react")
  const commands = createContext<(() => Promise<void>) | undefined>(undefined)
  const Container = ({ children }: { children: ReactNode }) => <>{children}</>
  const Empty = () => null
  return {
    useProviderForm: () => ({
      form: {},
      autosave: {
        reconcile: vi.fn<(value: APIProviderConfig | undefined) => void>(),
        discard: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      },
    }),
    CustomProviderEditor: {
      Provider: ({
        providerConfig,
        delete: deleteProvider,
        children,
      }: {
        providerConfig: APIProviderConfig
        delete: () => Promise<void>
        children: ReactNode
      }) => (
        <commands.Provider value={deleteProvider}>
          <div data-testid="provider-editor">{providerConfig.id}</div>
          {children}
        </commands.Provider>
      ),
    },
    ProviderEditor: {
      Form: Container,
      ConfigHeader: Empty,
      NameField: Empty,
      DescriptionField: Empty,
      ConnectionFields: Empty,
      ProviderSpecificFields: Empty,
      TranslationModelFields: Empty,
      Assignments: Container,
      CompatibleFeatureAssignments: Empty,
      LanguageDetectionAssignment: Empty,
      CustomActionAssignments: Empty,
      AdvancedFields: Empty,
      DuplicateButton: Empty,
      DeleteButton: () => {
        const deleteProvider = useContext(commands)
        return (
          <button type="button" onClick={() => void deleteProvider?.()}>
            Delete provider
          </button>
        )
      },
    },
  }
})

function configWithInertAssignments(enabled: boolean) {
  const config = structuredClone(DEFAULT_CONFIG)
  const inert = {
    ...structuredClone(DEFAULT_PROVIDER_CONFIG.byos),
    id: "legacy-experimental",
    enabled,
  }
  const byok = {
    ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai),
    id: "api-to-delete",
    name: "API to delete",
  }
  config.providersConfig = [inert, byok]
  config.pageTranslation.providerId = inert.id
  config.videoSubtitles.providerId = inert.id
  config.selectionToolbar.features.translate.providerId = inert.id
  config.selectionToolbar.noteSuggestion.providerId = inert.id
  config.selectionToolbar.builtInActions.dictionary.providerId = inert.id
  config.selectionToolbar.builtInActions.sentenceAnalysis.providerId = inert.id
  config.selectionToolbar.customActions = [
    {
      ...createDefaultDictionaryAction(),
      id: "legacy-custom-action",
      name: "Saved custom action",
      providerId: inert.id,
      layout: "Historical inert layout",
    },
  ]
  config.languageDetection = { mode: "llm", providerId: inert.id }
  config.translationHub.selectedProviderIds = [inert.id]
  return { config, inert, byok }
}

describe("provider editor selection after deletion", () => {
  it.each([true, false])(
    "clears the editor when only BYOS remains (enabled %s)",
    async (enabled) => {
      const { config, inert, byok } = configWithInertAssignments(enabled)
      const store = createStore()
      store.set(configAtom, config)
      await store.set(selectedProviderIdAtom, byok.id)
      render(
        <Provider store={store}>
          <ProviderConfigForm />
        </Provider>,
      )
      expect(screen.getByTestId("provider-editor")).toHaveTextContent(byok.id)

      fireEvent.click(screen.getByRole("button", { name: "Delete provider" }))

      await waitFor(() => expect(store.get(selectedProviderIdAtom)).toBeUndefined())
      expect(screen.queryByTestId("provider-editor")).not.toBeInTheDocument()
      expect(store.get(configAtom)).toEqual({ ...config, providersConfig: [inert] })
    },
  )

  it("selects the next API row instead of an earlier inert row", async () => {
    const { config, inert, byok } = configWithInertAssignments(false)
    const remaining = {
      ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai),
      id: "remaining-api",
      name: "Remaining API",
      enabled: false,
    }
    config.providersConfig.push(remaining)
    const store = createStore()
    store.set(configAtom, config)
    await store.set(selectedProviderIdAtom, byok.id)
    render(
      <Provider store={store}>
        <ProviderConfigForm />
      </Provider>,
    )

    fireEvent.click(screen.getByRole("button", { name: "Delete provider" }))

    await waitFor(() => expect(store.get(selectedProviderIdAtom)).toBe(remaining.id))
    expect(screen.getByTestId("provider-editor")).toHaveTextContent(remaining.id)
    expect(store.get(configAtom)).toEqual({ ...config, providersConfig: [inert, remaining] })
  })
})
