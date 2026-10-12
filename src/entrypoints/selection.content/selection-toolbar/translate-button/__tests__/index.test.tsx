// @vitest-environment jsdom
import type { ComponentProps, ReactElement, ReactNode } from "react"
import type { Config } from "@/types/config/config"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { cloneElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { configAtom } from "@/utils/atoms/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { TranslateButton } from ".."

const mocks = vi.hoisted(() => ({
  prepareToolbarOpen: vi.fn<(...args: any[]) => any>(),
  sendMessage: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/message", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/message")>()),
  sendMessage: mocks.sendMessage,
}))

vi.mock("@/components/ui/selection-popover", () => ({
  SelectionPopover: {
    Trigger: ({ children, ...props }: ComponentProps<"button">) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
  },
}))

// Keeps the trigger element and its children; a plain-string tooltip is rendered beside them.
vi.mock("@/components/ui/selection-popover/selection-tooltip", () => ({
  SelectionToolbarTooltip: ({
    content,
    render: renderElement,
    children,
  }: {
    content: ReactNode
    render: ReactElement
    children?: ReactNode
  }) =>
    cloneElement(
      renderElement,
      undefined,
      children,
      typeof content === "string" ? <span data-testid="tooltip-content">{content}</span> : null,
    ),
}))

vi.mock("../provider", () => ({
  useSelectionTranslationPopover: () => ({
    prepareToolbarOpen: mocks.prepareToolbarOpen,
  }),
}))

const PROVIDER_ID = "selection-provider"

// The stored config too: the config atom reloads it once mounted.
async function renderButton(edit?: (config: Config) => void) {
  const config = structuredClone(DEFAULT_CONFIG)
  config.providersConfig = [
    { ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai), id: PROVIDER_ID, enabled: true },
  ]
  // Only selection translation gets a provider; page translation, subtitles and the actions
  // stay unassigned, which must not hold this button back.
  config.selectionToolbar.features.translate.providerId = PROVIDER_ID
  edit?.(config)
  await fakeBrowser.storage.local.set({ [CONFIG_STORAGE_KEY]: config })
  const store = createStore()
  store.set(configAtom, config)
  render(
    <Provider store={store}>
      <TranslateButton />
    </Provider>,
  )
}

describe("translateButton", () => {
  beforeEach(() => {
    mocks.prepareToolbarOpen.mockReset()
    mocks.sendMessage.mockReset()
  })

  afterEach(() => {
    cleanup()
    fakeBrowser.reset()
  })

  it("blurs the toolbar trigger before opening the translation popover", async () => {
    await renderButton()

    const trigger = screen.getByRole("button", { name: "action.translation" })
    expect(trigger).toBeEnabled()
    const blurSpy = vi.spyOn(trigger, "blur")

    trigger.focus()
    expect(trigger).toHaveFocus()

    fireEvent.click(trigger)

    expect(blurSpy).toHaveBeenCalledOnce()
    expect(mocks.prepareToolbarOpen).toHaveBeenCalledOnce()
    expect(blurSpy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prepareToolbarOpen.mock.invocationCallOrder[0]!,
    )
    expect(document.activeElement).not.toBe(trigger)
  })

  it.each([
    [
      "unassigned",
      (config: Config) => {
        config.selectionToolbar.features.translate.providerId = "unconfigured"
      },
    ],
    [
      "deleted",
      (config: Config) => {
        config.providersConfig = []
      },
    ],
    [
      "disabled",
      (config: Config) => {
        config.providersConfig[0]!.enabled = false
      },
    ],
  ])("is disabled and says why when the provider is %s", async (_case, edit) => {
    await renderButton(edit)

    const trigger = screen.getByRole("button", { name: "action.translation" })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAccessibleDescription("providerRequired.message")
    expect(screen.getByTestId("tooltip-content")).toHaveTextContent("providerRequired.message")

    fireEvent.click(trigger)
    expect(mocks.prepareToolbarOpen).not.toHaveBeenCalled()
  })

  it("offers a focusable link to this feature's own provider setting", async () => {
    await renderButton((config) => {
      config.providersConfig = []
    })

    const settings = screen.getByRole("button", {
      name: "action.translation: providerRequired.openSettings",
    })
    expect(settings).toBeEnabled()
    expect(settings).toHaveAccessibleDescription("providerRequired.message")
    settings.focus()
    expect(settings).toHaveFocus()
    screen.getByRole("button", { name: "action.translation" }).focus()
    expect(settings).toHaveFocus()

    fireEvent.click(settings)

    expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith("openOptionsPage", {
      route: "/api-providers?section=feature-provider-selectionTranslation",
    })
    expect(mocks.prepareToolbarOpen).not.toHaveBeenCalled()
  })

  it("shows no settings link while a provider is chosen", async () => {
    await renderButton()

    expect(screen.queryByText("providerRequired.message")).not.toBeInTheDocument()
    expect(screen.getAllByRole("button")).toHaveLength(1)
  })
})
