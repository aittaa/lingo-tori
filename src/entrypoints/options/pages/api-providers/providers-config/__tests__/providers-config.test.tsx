// @vitest-environment jsdom

import type { ReactNode } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ProvidersConfig } from "@/entrypoints/options/pages/api-providers/providers-config"

const {
  anchoredToastAddMock,
  configAtom,
  highlightedProviderFieldAtom,
  providerWriteAtom,
  providersAtom,
  selectedProviderIdAtom,
  setProviderConfigMock,
  testState,
  writeConfigMock,
  writeConfigAtom,
} = vi.hoisted(() => ({
  anchoredToastAddMock: vi.fn<(options: unknown) => void>(),
  configAtom: {},
  highlightedProviderFieldAtom: {},
  providerWriteAtom: {},
  providersAtom: {},
  selectedProviderIdAtom: {},
  setProviderConfigMock: vi.fn<(value: unknown) => void>(),
  testState: { selectedProviderId: "provider-1" },
  writeConfigMock: vi.fn<(value: unknown) => void>(),
  writeConfigAtom: {},
}))

const providerConfig = {
  enabled: true,
  id: "provider-1",
  name: "Long Provider Name",
  provider: "openai",
}

const config = {
  languageDetection: { mode: "basic", providerId: undefined as string | undefined },
  providersConfig: [providerConfig],
  selectionToolbar: { customActions: [] },
}

vi.mock("jotai", () => ({
  useAtom: (atom: object) => {
    if (atom === providersAtom) return [[providerConfig], vi.fn<(value: unknown) => void>()]
    if (atom === selectedProviderIdAtom)
      return [
        testState.selectedProviderId,
        (value: string) => {
          testState.selectedProviderId = value
        },
      ]
    return [undefined, vi.fn<(value: unknown) => void>()]
  },
  useAtomValue: (atom: object) => {
    if (atom === selectedProviderIdAtom) return testState.selectedProviderId
    if (atom === configAtom) return config
    if (atom === providersAtom) return [providerConfig]
    return undefined
  },
  useSetAtom: (atom: object) => {
    if (atom === providerWriteAtom) return setProviderConfigMock
    if (atom === writeConfigAtom) return writeConfigMock
    if (atom === selectedProviderIdAtom)
      return (value: string) => {
        testState.selectedProviderId = value
      }
    return vi.fn<(value: unknown) => void>()
  },
}))

vi.mock("@/components/provider-icon", () => ({
  default: ({ name }: { name: string }) => <span>{name}</span>,
}))

vi.mock("@/components/providers/theme-provider", () => ({
  useTheme: () => ({ theme: "light" }),
}))

vi.mock("@/components/sortable-list", () => ({
  SortableList: ({
    list,
    renderItem,
  }: {
    list: (typeof providerConfig)[]
    renderItem: (item: typeof providerConfig) => ReactNode
  }) => <>{list.map(renderItem)}</>,
}))

vi.mock("@/components/ui/base-ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogTrigger: () => null,
}))

vi.mock("@/components/ui/base-ui/toast", () => ({
  anchoredToastManager: { add: anchoredToastAddMock },
}))

vi.mock("@/components/ui/base-ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  // Keep hover-only content out of the tree so editor-panel assertions do not
  // collide with the assignment names repeated inside card badges.
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock("@/utils/atoms/config", () => ({
  configAtom,
  configFieldsAtomMap: { providersConfig: providersAtom },
  writeConfigAtom,
}))

vi.mock("@/utils/atoms/entity-config", () => ({
  patchProviderConfigAtom: providerWriteAtom,
}))

vi.mock("@/utils/config/helpers", () => ({
  getAPIProvidersConfig: (providers: unknown[]) => providers,
  getProviderConfigById: (providers: (typeof providerConfig)[], id: string) =>
    providers.find((provider) => provider.id === id),
}))

vi.mock("@/utils/constants/feature-providers", () => ({
  FEATURE_KEYS: [
    "pageTranslation",
    "videoSubtitles",
    "selectionTranslation",
    "inputTranslation",
    "noteSuggestion",
  ],
  FEATURE_PROVIDER_DEFS: {
    pageTranslation: { getProviderId: () => providerConfig.id },
    selectionTranslation: { getProviderId: () => "unassigned-provider" },
    // Mirrors the shipped default: note suggestion runs on the OpenAI default
    // provider, so no built-in card starts with a feature assignment.
    noteSuggestion: { getProviderId: () => "openai-default" },
    // Both default to Microsoft, so neither starts assigned to a built-in.
    videoSubtitles: { getProviderId: () => "microsoft-translate-default" },
    inputTranslation: { getProviderId: () => "microsoft-translate-default" },
  },
  buildFeatureProviderPatch: () => ({}),
  getFeatureLabelI18nKey: (key: string) => `feature.${key}`,
}))

vi.mock("@/utils/i18n", () => ({
  i18n: {
    t: (key: string, values?: Array<string | number>) =>
      values ? `${key}:${values.join("|")}` : key,
  },
}))

vi.mock("@/entrypoints/options/components/config-item", () => ({
  ConfigItem: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock("@/entrypoints/options/components/entity-editor-layout", () => ({
  EntityEditorLayout: ({ list, editor }: { list: ReactNode; editor: ReactNode }) => (
    <>
      {list}
      {editor}
    </>
  ),
}))

vi.mock("@/entrypoints/options/components/entity-list-rail", () => ({
  EntityListRail: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock("@/entrypoints/options/pages/api-providers/providers-config/add-provider-dialog", () => ({
  default: () => null,
}))

vi.mock("@/entrypoints/options/pages/api-providers/providers-config/atoms", () => ({
  highlightedProviderFieldAtom,
  PROVIDER_FIELD_HIGHLIGHT_DURATION_MS: 2700,
  selectedProviderIdAtom,
}))

vi.mock("@/entrypoints/options/pages/api-providers/providers-config/provider-config-form", () => ({
  ProviderConfigForm: () => null,
}))

// `ProvidersConfig` reads the location to honour a `?provider=` deep link.
function renderProvidersConfig(initialEntry = "/api-providers") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ProvidersConfig />
    </MemoryRouter>,
  )
}

describe("ProvidersConfig", () => {
  beforeEach(() => {
    anchoredToastAddMock.mockReset()
    setProviderConfigMock.mockReset()
    writeConfigMock.mockReset()
    testState.selectedProviderId = providerConfig.id
    config.languageDetection = { mode: "basic", providerId: undefined }
  })

  it("anchors an in-use disable error to the corresponding provider switch", () => {
    renderProvidersConfig()

    const providerSwitch = screen.getByRole("switch", { name: providerConfig.name })
    fireEvent.click(providerSwitch)

    expect(setProviderConfigMock).not.toHaveBeenCalled()
    expect(anchoredToastAddMock).toHaveBeenCalledWith({
      id: "provider-disable-provider-1",
      positionerProps: { anchor: providerSwitch, sideOffset: 6 },
      title: "options.apiProviders.form.providerInUseCannotDisable:Long Provider Name|1",
      type: "error",
    })
  })

  it("lists local providers without hosted tiers", () => {
    renderProvidersConfig()
    expect(
      screen.queryByText("options.apiProviders.providers.name.builtInAi"),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText("options.apiProviders.providers.name.builtInAiAdvance"),
    ).not.toBeInTheDocument()
    expect(screen.getByRole("switch", { name: providerConfig.name })).toBeInTheDocument()
  })

  it("opens the provider a ?provider= deep link names", () => {
    testState.selectedProviderId = "other-local-provider"

    renderProvidersConfig(`/api-providers?provider=${providerConfig.id}`)

    expect(testState.selectedProviderId).toBe(providerConfig.id)
  })

  it("keeps the current selection when the deep link names an unknown provider", () => {
    testState.selectedProviderId = "other-local-provider"

    renderProvidersConfig("/api-providers?provider=deleted-provider")

    expect(testState.selectedProviderId).toBe("other-local-provider")
  })
})
