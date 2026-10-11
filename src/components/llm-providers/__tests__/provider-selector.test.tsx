// @vitest-environment jsdom
import type { ProviderSelectorOption } from "@/utils/providers/provider-display"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import ProviderSelector from "../provider-selector"

const { translateMock } = vi.hoisted(() => ({
  translateMock: vi.fn<(key: string) => string>(),
}))

vi.mock("@/utils/i18n", () => ({ i18n: { t: translateMock } }))

vi.mock("@/components/providers/theme-provider", () => ({
  useTheme: () => ({ theme: "light" }),
}))

afterEach(cleanup)

const openai = DEFAULT_PROVIDER_CONFIG.openai
const deepl = DEFAULT_PROVIDER_CONFIG.deepl
const placeholder = "Choose a provider"
const defaultPromptKey = "options.selectionToolbar.customActions.form.selectProvider"
const localizedPrompt = "제공업체 선택"

beforeEach(() => {
  translateMock.mockReset()
  translateMock.mockImplementation((key) => (key === defaultPromptKey ? localizedPrompt : key))
})

function renderSelector(providers: ProviderSelectorOption[], value = "unconfigured") {
  return render(
    <ProviderSelector
      providers={providers}
      value={value}
      onChange={vi.fn<(id: string) => void>()}
      placeholder={placeholder}
    />,
  )
}

describe("ProviderSelector with no selected provider", () => {
  it.each([
    ["empty", []],
    ["ungrouped", [openai]],
    ["grouped", [openai, deepl]],
  ] as const)(
    "uses the localized default prompt in the %s picker without an override",
    (_layout, providers) => {
      const onChange = vi.fn<(id: string) => void>()
      render(
        <ProviderSelector
          providers={[...providers]}
          value="unresolved-saved-id"
          onChange={onChange}
        />,
      )

      const trigger = screen.getByRole("combobox")
      expect(trigger).toHaveTextContent(localizedPrompt)
      expect(translateMock).toHaveBeenCalledWith(defaultPromptKey)
      if (providers.length === 0) expect(trigger).toBeDisabled()
      else expect(trigger).not.toBeDisabled()
      expect(onChange).not.toHaveBeenCalled()
    },
  )

  it.each([
    ["empty", []],
    ["ungrouped", [openai]],
    ["grouped", [openai, deepl]],
  ] as const)("preserves an explicit empty placeholder in the %s picker", (_layout, providers) => {
    render(
      <ProviderSelector
        providers={[...providers]}
        value="unresolved-saved-id"
        onChange={vi.fn<(id: string) => void>()}
        placeholder=""
      />,
    )

    expect(screen.getByRole("combobox").textContent).toBe("")
  })

  it.each([
    ["ungrouped", [openai]],
    ["grouped", [openai, deepl]],
  ] as const)(
    "shows the default prompt when the selected option is filtered from the %s picker",
    (_layout, providers) => {
      const onChange = vi.fn<(id: string) => void>()
      const { rerender } = render(
        <ProviderSelector providers={[...providers]} value={openai.id} onChange={onChange} />,
      )
      expect(screen.getByRole("combobox")).toHaveTextContent(openai.name)

      rerender(
        <ProviderSelector
          providers={providers.filter((provider) => provider.id !== openai.id)}
          value={openai.id}
          onChange={onChange}
        />,
      )

      expect(screen.getByRole("combobox")).toHaveTextContent(localizedPrompt)
      expect(onChange).not.toHaveBeenCalled()
    },
  )

  it("renders the fresh-install empty provider list as a disabled placeholder", () => {
    renderSelector([])
    expect(screen.getByRole("combobox")).toBeDisabled()
    expect(screen.getByRole("combobox")).toHaveTextContent(placeholder)
  })

  it.each([
    ["ungrouped", [openai]],
    ["grouped", [openai, deepl]],
  ] as const)("renders an unresolved selection in the %s picker", (_layout, providers) => {
    const { rerender } = renderSelector([...providers])
    expect(screen.getByRole("combobox")).toHaveTextContent(placeholder)
    expect(screen.getByRole("combobox")).not.toBeDisabled()

    rerender(
      <ProviderSelector
        providers={[...providers]}
        value={openai.id}
        onChange={vi.fn<(id: string) => void>()}
        placeholder={placeholder}
      />,
    )
    expect(screen.getByRole("combobox")).toHaveTextContent(openai.name)

    rerender(
      <ProviderSelector
        providers={[...providers]}
        value="removed-provider"
        onChange={vi.fn<(id: string) => void>()}
        placeholder={placeholder}
      />,
    )
    expect(screen.getByRole("combobox")).toHaveTextContent(placeholder)
  })
})
