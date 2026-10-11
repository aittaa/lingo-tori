// @vitest-environment jsdom
import type { ProviderSelectorOption } from "@/utils/providers/provider-display"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import ProviderSelector from "../provider-selector"

vi.mock("@/components/providers/theme-provider", () => ({
  useTheme: () => ({ theme: "light" }),
}))

afterEach(cleanup)

const openai = DEFAULT_PROVIDER_CONFIG.openai
const deepl = DEFAULT_PROVIDER_CONFIG.deepl
const placeholder = "Choose a provider"

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
