// @vitest-environment jsdom
import type { ReactElement, ReactNode } from "react"
import type { Config } from "@/types/config/config"
import type { ProviderConfig } from "@/types/config/provider"
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { cloneElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { configAtom } from "@/utils/atoms/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { getBuiltInDictionaryAction } from "@/utils/custom-actions"
import { SelectionToolbarCustomActionTrigger } from "../custom-action-trigger"

const mocks = vi.hoisted(() => ({
  openToolbarCustomAction: vi.fn<(...args: any[]) => any>(),
  sendMessage: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/message", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/message")>()),
  sendMessage: mocks.sendMessage,
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
  useSelectionCustomActionPopover: () => ({
    openToolbarCustomAction: mocks.openToolbarCustomAction,
  }),
}))

const PROVIDER_ID = "action-provider"

const llmProvider = (): ProviderConfig => ({
  ...structuredClone(DEFAULT_PROVIDER_CONFIG.openai),
  id: PROVIDER_ID,
  enabled: true,
})

// The stored config too: the config atom reloads it once mounted.
async function renderTrigger(providerId: string, providers: ProviderConfig[] = [llmProvider()]) {
  const config: Config = structuredClone(DEFAULT_CONFIG)
  config.providersConfig = providers
  // Only this action gets a provider (or not); the built-in feature slots stay unassigned.
  const action: SelectionToolbarCustomAction = {
    ...getBuiltInDictionaryAction(config.selectionToolbar),
    id: "summarize",
    name: "Summarize",
    icon: "tabler:sparkles",
    providerId,
  }
  config.selectionToolbar.customActions = [action]
  await fakeBrowser.storage.local.set({ [CONFIG_STORAGE_KEY]: config })
  const store = createStore()
  store.set(configAtom, config)
  render(
    <Provider store={store}>
      <SelectionToolbarCustomActionTrigger action={action} />
    </Provider>,
  )
}

describe("selectionToolbarCustomActionTrigger", () => {
  beforeEach(() => {
    mocks.openToolbarCustomAction.mockReset()
    mocks.sendMessage.mockReset()
  })

  afterEach(() => {
    cleanup()
    fakeBrowser.reset()
  })

  it("blurs the toolbar trigger before opening the custom action popover", async () => {
    await renderTrigger(PROVIDER_ID)

    const trigger = screen.getByRole("button", { name: "Summarize" })
    expect(trigger).toBeEnabled()
    const blurSpy = vi.spyOn(trigger, "blur")

    trigger.focus()
    expect(trigger).toHaveFocus()

    fireEvent.click(trigger)

    expect(blurSpy).toHaveBeenCalledOnce()
    expect(mocks.openToolbarCustomAction).toHaveBeenCalledOnce()
    expect(mocks.openToolbarCustomAction).toHaveBeenCalledWith("summarize", trigger)
    expect(blurSpy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.openToolbarCustomAction.mock.invocationCallOrder[0]!,
    )
    expect(document.activeElement).not.toBe(trigger)
  })

  it.each([
    ["unassigned", "unconfigured", undefined],
    ["deleted", "gone", undefined],
    ["disabled", PROVIDER_ID, [{ ...llmProvider(), enabled: false }]],
    [
      "translation-only",
      "deepl-default",
      [llmProvider(), { ...structuredClone(DEFAULT_PROVIDER_CONFIG.deepl), enabled: true }],
    ],
  ])("is disabled and says why when its provider is %s", async (_case, providerId, providers) => {
    await renderTrigger(providerId, providers)

    const trigger = screen.getByRole("button", { name: "Summarize" })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAccessibleDescription("providerRequired.message")
    expect(screen.getByTestId("tooltip-content")).toHaveTextContent("providerRequired.message")

    fireEvent.click(trigger)
    expect(mocks.openToolbarCustomAction).not.toHaveBeenCalled()
  })

  it("offers a focusable link to this action's own provider row", async () => {
    await renderTrigger("unconfigured")

    const settings = screen.getByRole("button", {
      name: "Summarize: providerRequired.openSettings",
    })
    expect(settings).toBeEnabled()
    expect(settings).toHaveAccessibleDescription("providerRequired.message")
    settings.focus()
    expect(settings).toHaveFocus()
    screen.getByRole("button", { name: "Summarize" }).focus()
    expect(settings).toHaveFocus()

    fireEvent.click(settings)

    expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith("openOptionsPage", {
      route: "/api-providers?section=feature-provider-action-summarize",
    })
    expect(mocks.openToolbarCustomAction).not.toHaveBeenCalled()
  })

  it("shows no settings link while a provider is chosen", async () => {
    await renderTrigger(PROVIDER_ID)

    expect(screen.queryByText("providerRequired.message")).not.toBeInTheDocument()
    expect(screen.getAllByRole("button")).toHaveLength(1)
  })
})
