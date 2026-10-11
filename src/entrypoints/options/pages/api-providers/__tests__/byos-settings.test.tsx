// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Dialog } from "@/components/ui/base-ui/dialog"
import { configAtom } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { ApiProvidersPage } from ".."
import AddProviderDialog from "../providers-config/add-provider-dialog"

const mocks = vi.hoisted(() => ({
  send: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  locale: "en",
  chromium: true,
  dnrAvailable: true,
  permission: vi.fn<() => Promise<boolean>>(),
}))

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      getURL: () =>
        mocks.chromium ? "chrome-extension://extension/" : "moz-extension://extension/",
    },
    get declarativeNetRequest() {
      return mocks.dnrAvailable ? {} : undefined
    },
    permissions: { request: mocks.permission },
  },
}))
vi.mock("@/components/provider-icon", () => ({ default: () => <span aria-hidden="true" /> }))
vi.mock("@/components/providers/theme-provider", () => ({ useTheme: () => ({ theme: "light" }) }))
vi.mock("@/utils/byos/messages", () => ({ sendByosMessage: mocks.send }))
vi.mock("@/utils/i18n", () => ({
  getUiLocale: () => mocks.locale,
  i18n: { t: (key: string) => key },
}))
vi.mock("@/utils/atoms/config", async () => {
  const { atom } = await import("jotai")
  const { DEFAULT_CONFIG: initialConfig } = await import("@/utils/constants/config")
  const testConfigAtom = atom(initialConfig)
  return {
    configAtom: testConfigAtom,
    configFieldsAtomMap: {
      providersConfig: atom(
        (get) => get(testConfigAtom).providersConfig,
        async (get, set, providersConfig: typeof initialConfig.providersConfig) => {
          set(testConfigAtom, { ...get(testConfigAtom), providersConfig })
        },
      ),
    },
    writeConfigAtom: atom(
      null,
      async (get, set, update: (config: typeof initialConfig) => Partial<typeof initialConfig>) => {
        set(testConfigAtom, { ...get(testConfigAtom), ...update(get(testConfigAtom)) })
      },
    ),
  }
})
vi.mock("../providers-config", async () => {
  const { useState } = await import("react")
  return {
    ProvidersConfig: function MockProvidersConfig({
      onSelectChatGPT,
    }: {
      onSelectChatGPT?: () => void
    }) {
      const [open, setOpen] = useState(false)
      return (
        <section aria-label="API providers">
          <h2>API providers</h2>
          <label>
            BYOK API key
            <input defaultValue="keep-my-key" />
          </label>
          <button type="button" onClick={() => setOpen(true)}>
            Add provider
          </button>
          <Dialog open={open} onOpenChange={setOpen}>
            <AddProviderDialog onClose={() => setOpen(false)} onSelectChatGPT={onSelectChatGPT} />
          </Dialog>
        </section>
      )
    },
  }
})
vi.mock("../feature-providers", () => ({
  FeatureProvidersConfig: () => <div>Feature providers</div>,
}))
vi.mock("../language-detection", () => ({
  LanguageDetectionConfig: () => <div>Language detection</div>,
}))
vi.mock("../ai-content-aware", () => ({
  AIContentAwareConfig: () => <div>Content aware translation</div>,
}))

beforeEach(() => {
  mocks.locale = "en"
  mocks.chromium = true
  mocks.dnrAvailable = true
  mocks.permission.mockReset()
  mocks.permission.mockResolvedValue(true)
  mocks.send.mockReset()
  mocks.send.mockImplementation(async (type) =>
    type === "lingotoriByosSession"
      ? { state: "disconnected" }
      : type === "lingotoriByosSignout"
        ? { state: "disconnected", remoteRevocationConfirmed: false }
        : undefined,
  )
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderSettings() {
  const store = createStore()
  const config = structuredClone(DEFAULT_CONFIG)
  config.providersConfig = [
    {
      ...structuredClone(DEFAULT_PROVIDER_CONFIG.byos),
      id: "historical-byos",
      name: "Saved BYOS provider",
      model: { model: "use-custom-model", isCustomModel: true, customModel: "historical-model" },
    },
  ]
  store.set(configAtom, config)
  render(
    <Provider store={store}>
      <ApiProvidersPage />
    </Provider>,
  )
  return store
}

const account = { subject: "synthetic-subject", email: "person@example.test" }
const connected = { state: "plan-enabled", account }
const availableModels = { models: [{ slug: "synthetic-model", display_name: "Synthetic Model" }] }
async function waitForSignedOut() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeEnabled(),
  )
}
async function openAccountMenu() {
  fireEvent.click(screen.getByRole("button", { name: "ChatGPT account options" }))
  await waitFor(() =>
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument(),
  )
}
function mockConnected() {
  mocks.send.mockImplementation(async (type) =>
    type === "lingotoriByosSession"
      ? connected
      : type === "lingotoriByosModels"
        ? availableModels
        : type === "lingotoriByosSignout"
          ? { state: "disconnected", remoteRevocationConfirmed: false }
          : undefined,
  )
}

describe("compact ChatGPT provider card", () => {
  it("comes before API providers and shows only sign-in when disconnected", async () => {
    const store = renderSettings(),
      initial = store.get(configAtom)
    await waitForSignedOut()
    const card = screen.getByRole("region", { name: "ChatGPT" })
    const api = screen.getByRole("region", { name: "API providers" })
    expect(card.compareDocumentPosition(api) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "options.apiProviders.title",
    )
    expect(
      screen.queryByText(/Experimental BYOS|local-runtime|live sign-in/i),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "ChatGPT account options" }),
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument()
    expect(screen.getByLabelText("BYOK API key")).toHaveValue("keep-my-key")
    expect(mocks.permission).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalledWith("lingotoriByosAuth", undefined)
    expect(store.get(configAtom)).toBe(initial)
  })
  it("requests permission in the sign-in click and stays pending after auth starts", async () => {
    renderSettings()
    await waitForSignedOut()
    fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }))
    expect(mocks.permission).toHaveBeenCalledWith({
      permissions: ["declarativeNetRequestWithHostAccess"],
    })
    await waitFor(() =>
      expect(screen.getByText("Complete sign-in in the opened tab.")).toBeInTheDocument(),
    )
    expect(mocks.send).toHaveBeenCalledWith("lingotoriByosAuth", undefined)
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled()
    expect(screen.queryByRole("button", { name: "Sign in with ChatGPT" })).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "ChatGPT account options" }),
    ).not.toBeInTheDocument()
    mocks.send.mockImplementation(async (type) =>
      type === "lingotoriByosSession"
        ? connected
        : type === "lingotoriByosModels"
          ? availableModels
          : undefined,
    )
    fireEvent(window, new Event("focus"))
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("synthetic-model"))
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
    expect(mocks.send.mock.calls.filter(([type]) => type === "lingotoriByosAuth")).toHaveLength(1)
  })
  it("cancels a late permission grant without reopening login", async () => {
    let release!: (value: boolean) => void
    mocks.permission.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    mocks.dnrAvailable = false
    renderSettings()
    await waitForSignedOut()
    fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }))
    expect(screen.getByText("Waiting for sign-in permission…")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitForSignedOut()
    await act(async () => release(true))
    expect(mocks.send).toHaveBeenCalledWith("lingotoriByosCancelAuth", undefined)
    expect(mocks.send).not.toHaveBeenCalledWith("lingotoriByosAuth", undefined)
  })
  it("shows permission denial and synchronous or asynchronous permission failure", async () => {
    mocks.permission.mockResolvedValueOnce(false)
    renderSettings()
    await waitForSignedOut()
    fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }))
    await waitFor(() =>
      expect(screen.getByText("Sign-in permission was not granted.")).toBeInTheDocument(),
    )
    expect(mocks.send).not.toHaveBeenCalledWith("lingotoriByosAuth", undefined)
    mocks.permission.mockImplementationOnce(() => {
      throw new Error("synthetic permission failure")
    })
    fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }))
    expect(screen.getByText("Could not connect. Try again.")).toBeInTheDocument()
    mocks.permission.mockRejectedValueOnce(
      new Error("Could not establish connection. Receiving end does not exist."),
    )
    fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }))
    await waitFor(() =>
      expect(
        screen.getByText(
          "Extension connection unavailable. Reload this settings page and try again.",
        ),
      ).toBeInTheDocument(),
    )
  })
  it("keeps unsupported browsers explicit without requesting permission", async () => {
    mocks.chromium = false
    renderSettings()
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("lingotoriByosSession", undefined))
    expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeDisabled()
    expect(
      screen.getByText("ChatGPT sign-in is available in Chromium browsers."),
    ).toBeInTheDocument()
    expect(mocks.permission).not.toHaveBeenCalled()
  })
  it.each([
    ["ko", "ChatGPT로 로그인"],
    ["ja", "ChatGPT でログイン"],
  ])("localizes the sign-in action in %s", async (locale, label) => {
    mocks.locale = locale
    renderSettings()
    await waitFor(() => expect(screen.getByRole("button", { name: label })).toBeEnabled())
    expect(mocks.permission).not.toHaveBeenCalled()
  })
  it("places sign-out and usage in account overflow, with one save action and no automatic feature assignment", async () => {
    mockConnected()
    const store = renderSettings(),
      initial = store.get(configAtom)
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("synthetic-model"))
    expect(screen.getByText("person@example.test")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Sign in with ChatGPT" })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).not.toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Save model" })).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "Save model" }))
    await waitFor(() =>
      expect(
        store.get(configAtom).providersConfig.find((provider) => provider.provider === "byos")
          ?.model.customModel,
      ).toBe("synthetic-model"),
    )
    expect(store.get(configAtom).pageTranslation).toEqual(initial.pageTranslation)
    expect(store.get(configAtom).selectionToolbar).toEqual(initial.selectionToolbar)
    expect(screen.getByLabelText("BYOK API key")).toHaveValue("keep-my-key")
    await openAccountMenu()
    expect(screen.getByRole("menuitem", { name: "Manage ChatGPT usage" })).toHaveAttribute(
      "href",
      "https://chatgpt.com/#settings/Usage",
    )
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }))
    await waitForSignedOut()
    expect(
      screen.getByText("Signed out locally; remote revocation unconfirmed."),
    ).toBeInTheDocument()
  })
  it("discards late model discovery after sign-out", async () => {
    let release!: (value: unknown) => void
    const models = new Promise((resolve) => {
      release = resolve
    })
    mocks.send.mockImplementation(async (type) =>
      type === "lingotoriByosSession"
        ? connected
        : type === "lingotoriByosModels"
          ? models
          : type === "lingotoriByosSignout"
            ? { state: "disconnected", remoteRevocationConfirmed: true }
            : undefined,
    )
    renderSettings()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "ChatGPT account options" })).toBeInTheDocument(),
    )
    await openAccountMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }))
    await waitForSignedOut()
    await act(async () => release(availableModels))
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "ChatGPT account options" }),
    ).not.toBeInTheDocument()
    expect(screen.getByText("Signed out")).toBeInTheDocument()
  })
  it.each([
    ["reconnect-required", "Sign-in expired"],
    ["limit-reached", "Usage limit reached"],
    ["restricted", "Account access restricted"],
  ])("shows actual %s recovery after model discovery fails", async (state, status) => {
    let sessions = 0
    mocks.send.mockImplementation(async (type) =>
      type === "lingotoriByosSession"
        ? { state: ++sessions === 1 ? "plan-enabled" : state, account }
        : type === "lingotoriByosModels"
          ? Promise.reject(new Error("synthetic models failure"))
          : undefined,
    )
    renderSettings()
    await waitFor(() => expect(screen.getByText(status)).toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled()
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument()
    expect(mocks.permission).not.toHaveBeenCalled()
  })
  it("recovers a model-discovery failure without falsely showing ready access", async () => {
    mocks.send.mockImplementation(async (type) =>
      type === "lingotoriByosSession"
        ? connected
        : Promise.reject(new Error("synthetic unavailable models")),
    )
    renderSettings()
    await waitFor(() => expect(screen.getByText("Connection unavailable")).toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled()
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument()
  })
})

it("shows bounded feedback if the background never responds to sign-in and ignores late completion", async () => {
  renderSettings()
  await waitForSignedOut()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  mocks.send.mockImplementation(async (type) => (type === "lingotoriByosAuth" ? gate : undefined))
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }))
  await act(async () => {
    await Promise.resolve()
  })
  expect(screen.getByText("Opening sign-in…")).toBeInTheDocument()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000)
  })
  expect(
    screen.getByText("Extension connection unavailable. Reload this settings page and try again."),
  ).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeEnabled()
  expect(mocks.send).toHaveBeenCalledWith("lingotoriByosCancelAuth", undefined)
  await act(async () => release())
  expect(screen.queryByText("Complete sign-in in the opened tab.")).not.toBeInTheDocument()
})

it("shows a specific recovery message for a callback-routing timeout", async () => {
  renderSettings()
  await waitForSignedOut()
  mocks.send.mockImplementation(async (type) => {
    if (type === "lingotoriByosAuth") throw new Error("BYOS: callback_rule_timeout")
    return undefined
  })
  fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }))
  await waitFor(() =>
    expect(
      screen.getByText("Callback routing did not start. Reload the extension, then try again."),
    ).toBeInTheDocument(),
  )
  expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeEnabled()
})

it("returns to sign-in when the background no longer has the pending login", async () => {
  renderSettings()
  await waitForSignedOut()
  fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }))
  await waitFor(() =>
    expect(screen.getByText("Complete sign-in in the opened tab.")).toBeInTheDocument(),
  )
  mocks.send.mockResolvedValue({ state: "disconnected", authPending: false })
  fireEvent(window, new Event("focus"))

  await waitForSignedOut()
  expect(screen.getByText("Sign-in did not finish. Try again.")).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  expect(mocks.send.mock.calls.filter(([type]) => type === "lingotoriByosAuth")).toHaveLength(1)
})

it("the Add provider ChatGPT option uses the same gesture workflow and closes without a setup step", async () => {
  const store = renderSettings(),
    initial = store.get(configAtom)
  await waitForSignedOut()
  fireEvent.click(screen.getByRole("button", { name: "Add provider" }))
  const choice = await screen.findByRole("button", { name: "ChatGPT" })
  fireEvent.click(choice)
  expect(mocks.permission).toHaveBeenCalledOnce()
  await waitFor(() =>
    expect(screen.getByText("Complete sign-in in the opened tab.")).toBeInTheDocument(),
  )
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  expect(mocks.send.mock.calls.filter(([type]) => type === "lingotoriByosAuth")).toHaveLength(1)
  expect(store.get(configAtom)).toBe(initial)
  expect(screen.getByLabelText("BYOK API key")).toHaveValue("keep-my-key")
})
it("selecting ChatGPT while already connected focuses its model without duplicate authentication", async () => {
  mockConnected()
  renderSettings()
  await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("synthetic-model"))
  fireEvent.click(screen.getByRole("button", { name: "Add provider" }))
  fireEvent.click(await screen.findByRole("button", { name: "ChatGPT" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  await waitFor(() => expect(screen.getByLabelText("Model")).toHaveFocus())
  expect(mocks.permission).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalledWith("lingotoriByosAuth", undefined)
})
it("Firefox Add provider selection never requests undeclared callback permission", async () => {
  mocks.chromium = false
  renderSettings()
  await waitFor(() => expect(screen.getByText("Connect your account")).toBeInTheDocument())
  fireEvent.click(screen.getByRole("button", { name: "Add provider" }))
  fireEvent.click(await screen.findByRole("button", { name: "ChatGPT" }))
  expect(mocks.permission).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalledWith("lingotoriByosAuth", undefined)
})
it("reselecting ChatGPT during a pending grant cannot duplicate authentication", async () => {
  let release!: (value: boolean) => void
  mocks.permission.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve
    }),
  )
  renderSettings()
  await waitForSignedOut()
  fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }))
  fireEvent.click(screen.getByRole("button", { name: "Add provider" }))
  fireEvent.click(await screen.findByRole("button", { name: "ChatGPT" }))
  expect(mocks.permission).toHaveBeenCalledOnce()
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  await waitForSignedOut()
  await act(async () => release(true))
  expect(mocks.send).not.toHaveBeenCalledWith("lingotoriByosAuth", undefined)
})
