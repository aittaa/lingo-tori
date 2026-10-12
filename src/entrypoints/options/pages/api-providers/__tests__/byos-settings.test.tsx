// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
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
  protocol: "chrome-extension:",
  installedPermission: true,
  dnrAvailable: true,
  writeFailure: false,
  permission: vi.fn<() => Promise<boolean>>(),
  reload: vi.fn<() => void>(),
}))

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      reload: mocks.reload,
      getURL: () => `${mocks.protocol}//extension/`,
      getManifest: () => ({
        permissions: mocks.installedPermission ? ["declarativeNetRequestWithHostAccess"] : [],
      }),
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
  const { deepmergeCustom } = await import("deepmerge-ts")
  const mergeWithArrayOverwrite = deepmergeCustom({
    mergeArrays: (values) => values[values.length - 1],
  })
  const testConfigAtom = atom(initialConfig)
  return {
    configAtom: testConfigAtom,
    mergeWithArrayOverwrite,
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
        if (mocks.writeFailure) throw new Error("Synthetic config persistence failure")
        set(
          testConfigAtom,
          mergeWithArrayOverwrite(get(testConfigAtom), update(get(testConfigAtom))),
        )
      },
    ),
  }
})
vi.mock("../providers-config", async () => {
  const { useState } = await import("react")
  return {
    ProvidersConfig: function MockProvidersConfig() {
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
            <AddProviderDialog onClose={() => setOpen(false)} />
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
  mocks.protocol = "chrome-extension:"
  mocks.installedPermission = true
  mocks.writeFailure = false
  mocks.dnrAvailable = true
  mocks.permission.mockReset()
  mocks.permission.mockResolvedValue(true)
  mocks.reload.mockReset()
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

function renderSettings(initialProviders = true) {
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
  if (!initialProviders) config.providersConfig = []
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
const pendingAttemptId = "11111111-1111-4111-8111-111111111111"
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
function expectAuthCount(count: number) {
  expect(mocks.send.mock.calls.filter(([type]) => type === "lingotoriByosAuth")).toHaveLength(count)
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
    expectAuthCount(0)
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
    expect(mocks.send).toHaveBeenCalledWith("lingotoriByosAuth", expect.any(String))
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
    expect(mocks.send).toHaveBeenCalledWith("lingotoriByosCancelAuth", expect.any(String))
    expectAuthCount(0)
  })
  it("shows permission denial and synchronous or asynchronous permission failure", async () => {
    mocks.permission.mockResolvedValueOnce(false)
    renderSettings()
    await waitForSignedOut()
    fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }))
    await waitFor(() =>
      expect(screen.getByText("Sign-in permission was not granted.")).toBeInTheDocument(),
    )
    expectAuthCount(0)
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
    mocks.protocol = "https:"
    renderSettings()
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("lingotoriByosSession", undefined))
    expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeDisabled()
    expect(
      screen.getByText("ChatGPT sign-in is available in Firefox and Chromium browsers."),
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
  it.each(["az", "es", "ru", "tr", "vi", "zh-CN", "zh-TW"])(
    "uses English sign-in copy for restored locale %s without starting authentication",
    async (locale) => {
      mocks.locale = locale
      renderSettings()
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeEnabled(),
      )
      expect(mocks.permission).not.toHaveBeenCalled()
      expectAuthCount(0)
    },
  )
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
  expect(mocks.send).toHaveBeenCalledWith("lingotoriByosCancelAuth", expect.any(String))
  await act(async () => release())
  expect(screen.queryByText("Complete sign-in in the opened tab.")).not.toBeInTheDocument()
})

it.each(["callback_rule_timeout", "callback_rule_timeout_install", "callback_rule_timeout_remove"])(
  "shows a specific recovery message for %s",
  async (code) => {
    renderSettings()
    await waitForSignedOut()
    mocks.send.mockImplementation(async (type) => {
      if (type === "lingotoriByosAuth") throw new Error(`BYOS: ${code}`)
      return undefined
    })
    fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }))
    await waitFor(() =>
      expect(
        screen.getByText("If sign-in fails, restart the extension and try again."),
      ).toBeInTheDocument(),
    )
    expect(screen.getByRole("button", { name: "Restart extension" })).toBeEnabled()
    expect(mocks.reload).not.toHaveBeenCalled()
  },
)

async function failRouting() {
  mocks.send.mockImplementation(async (type) => {
    if (type === "lingotoriByosAuth") throw new Error("callback_rule_timeout_remove")
    return { state: "disconnected" }
  })
  fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }))
  return screen.findByRole("button", { name: "Restart extension" })
}

it("restarts only on click, ignores repeated clicks, and preserves settings for manual reconnection", async () => {
  const store = renderSettings()
  const saved = store.get(configAtom)
  await waitForSignedOut()
  const restart = await failRouting()
  expect(mocks.reload).not.toHaveBeenCalled()
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  act(() => {
    fireEvent.click(restart)
    fireEvent.click(restart)
    fireEvent.click(restart)
  })
  expect(mocks.reload).toHaveBeenCalledTimes(1)
  expect(restart).toBeDisabled()
  expect(store.get(configAtom)).toBe(saved)
  const callsBeforeFocus = mocks.send.mock.calls.length
  fireEvent(window, new Event("focus"))
  expect(mocks.send).toHaveBeenCalledTimes(callsBeforeFocus)
  expectAuthCount(1)

  cleanup()
  mocks.send.mockImplementation(async (type) =>
    type === "lingotoriByosSession" ? { state: "disconnected" } : undefined,
  )
  render(
    <Provider store={store}>
      <ApiProvidersPage />
    </Provider>,
  )
  await waitForSignedOut()
  expect(screen.queryByRole("button", { name: "Restart extension" })).not.toBeInTheDocument()
  expect(store.get(configAtom)).toBe(saved)
  expectAuthCount(1)
  fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }))
  await screen.findByText("Complete sign-in in the opened tab.")
  expectAuthCount(2)
  expect(mocks.reload).toHaveBeenCalledTimes(1)
})

it("shows restart failure and permits a new explicit attempt without changing settings", async () => {
  const store = renderSettings()
  const saved = store.get(configAtom)
  await waitForSignedOut()
  const restart = await failRouting()
  mocks.reload.mockImplementationOnce(() => {
    throw new Error("synthetic restart failure")
  })
  fireEvent.click(restart)
  expect(screen.getByText("Could not restart the extension. Try again.")).toBeInTheDocument()
  expect(restart).toBeEnabled()
  expect(store.get(configAtom)).toBe(saved)
  fireEvent.click(restart)
  expect(mocks.reload).toHaveBeenCalledTimes(2)
  expect(restart).toBeDisabled()
  expectAuthCount(1)
})

it("allows restart while a focus refresh is pending and ignores its late success", async () => {
  renderSettings()
  await waitForSignedOut()
  const restart = await failRouting()
  let release!: (value: unknown) => void
  mocks.send.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  fireEvent(window, new Event("focus"))
  expect(restart).toBeEnabled()
  fireEvent.click(restart)
  await act(async () => release(connected))
  expect(restart).toBeDisabled()
  expect(screen.queryByText(account.email)).not.toBeInTheDocument()
  expect(mocks.reload).toHaveBeenCalledTimes(1)
  expectAuthCount(1)
})

it("removes restart recovery when a later session refresh confirms a connected account", async () => {
  renderSettings()
  await waitForSignedOut()
  await failRouting()
  mockConnected()
  fireEvent(window, new Event("focus"))
  await screen.findByDisplayValue("Synthetic Model")
  expect(screen.queryByRole("button", { name: "Restart extension" })).not.toBeInTheDocument()
  expect(mocks.reload).not.toHaveBeenCalled()
})

it.each(["callback_permission_missing", "synthetic sign-in failure"])(
  "does not offer extension restart for unrelated failure %s",
  async (code) => {
    renderSettings()
    await waitForSignedOut()
    mocks.send.mockImplementation(async (type) => {
      if (type === "lingotoriByosAuth") throw new Error(code)
      return undefined
    })
    fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }))
    await waitForSignedOut()
    expect(screen.queryByRole("button", { name: "Restart extension" })).not.toBeInTheDocument()
    expect(mocks.reload).not.toHaveBeenCalled()
  },
)

it.each([
  [
    "en",
    "Sign in with ChatGPT",
    "Restart extension",
    "If sign-in fails, restart the extension and try again.",
  ],
  [
    "ko",
    "ChatGPT로 로그인",
    "확장 다시 시작",
    "연결이 안 되면 확장을 다시 시작한 뒤 다시 시도해 주세요.",
  ],
  [
    "ja",
    "ChatGPT でログイン",
    "拡張機能を再起動",
    "接続できない場合は、拡張機能を再起動してから再試行してください。",
  ],
])("localizes routing recovery in %s", async (locale, signIn, restart, notice) => {
  mocks.locale = locale
  renderSettings()
  await waitFor(() => expect(screen.getByRole("button", { name: signIn })).toBeEnabled())
  mocks.send.mockImplementation(async (type) => {
    if (type === "lingotoriByosAuth") throw new Error("callback_rule_timeout_install")
    return undefined
  })
  fireEvent.click(screen.getByRole("button", { name: signIn }))
  expect(await screen.findByRole("button", { name: restart })).toBeEnabled()
  expect(screen.getByText(notice)).toBeInTheDocument()
  expect(mocks.reload).not.toHaveBeenCalled()
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

it("Add provider omits ChatGPT but keeps OpenAI and the dedicated sign-in card", async () => {
  const store = renderSettings()
  const initial = store.get(configAtom)
  await waitForSignedOut()
  fireEvent.click(screen.getByRole("button", { name: "Add provider" }))
  const dialog = await screen.findByRole("dialog")
  expect(within(dialog).queryByRole("button", { name: "ChatGPT" })).not.toBeInTheDocument()
  expect(within(dialog).getByRole("button", { name: "OpenAI" })).toBeEnabled()
  expect(mocks.permission).not.toHaveBeenCalled()
  expectAuthCount(0)
  expect(store.get(configAtom)).toBe(initial)
  fireEvent.keyDown(dialog, { key: "Escape" })
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeEnabled()
  expect(screen.getByLabelText("BYOK API key")).toHaveValue("keep-my-key")
})
it("adds OpenAI through Add provider without replacing the stored ChatGPT provider", async () => {
  const store = renderSettings()
  const initial = store.get(configAtom)
  await waitForSignedOut()
  fireEvent.click(screen.getByRole("button", { name: "Add provider" }))
  const dialog = await screen.findByRole("dialog")
  fireEvent.click(within(dialog).getByRole("button", { name: "OpenAI" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  expect(store.get(configAtom).providersConfig).toEqual([
    ...initial.providersConfig,
    expect.objectContaining({ provider: "openai" }),
  ])
  expect(store.get(configAtom).selectionToolbar).toEqual(initial.selectionToolbar)
  expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeEnabled()
  expect(screen.getByLabelText("BYOK API key")).toHaveValue("keep-my-key")
  expect(mocks.permission).not.toHaveBeenCalled()
  expectAuthCount(0)
})
it("opening Add provider preserves a connected account, model and saved assignments", async () => {
  mockConnected()
  const store = renderSettings()
  const saved = store.get(configAtom)
  act(() =>
    store.set(configAtom, {
      ...saved,
      selectionToolbar: {
        ...saved.selectionToolbar,
        builtInActions: {
          ...saved.selectionToolbar.builtInActions,
          dictionary: {
            ...saved.selectionToolbar.builtInActions.dictionary,
            providerId: "historical-byos",
          },
        },
      },
    }),
  )
  await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("synthetic-model"))
  const initial = store.get(configAtom)
  fireEvent.click(screen.getByRole("button", { name: "Add provider" }))
  const dialog = await screen.findByRole("dialog")
  expect(within(dialog).queryByRole("button", { name: "ChatGPT" })).not.toBeInTheDocument()
  expect(within(dialog).getByRole("button", { name: "OpenAI" })).toBeEnabled()
  fireEvent.keyDown(dialog, { key: "Escape" })
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  expect(screen.getByLabelText("Model")).toHaveValue("synthetic-model")
  expect(screen.getByRole("button", { name: "ChatGPT account options" })).toBeEnabled()
  expect(store.get(configAtom)).toBe(initial)
  expect(mocks.permission).not.toHaveBeenCalled()
  expectAuthCount(0)
})
it("Firefox Add provider has no ChatGPT choice or callback permission request", async () => {
  mocks.protocol = "moz-extension:"
  const store = renderSettings()
  const initial = store.get(configAtom)
  await waitFor(() => expect(screen.getByText("Connect your account")).toBeInTheDocument())
  fireEvent.click(screen.getByRole("button", { name: "Add provider" }))
  const dialog = await screen.findByRole("dialog")
  expect(within(dialog).queryByRole("button", { name: "ChatGPT" })).not.toBeInTheDocument()
  expect(within(dialog).getByRole("button", { name: "OpenAI" })).toBeEnabled()
  expect(store.get(configAtom)).toBe(initial)
  expect(mocks.permission).not.toHaveBeenCalled()
  expectAuthCount(0)
})
it("Firefox dedicated sign-in checks its installed capability without an unsupported optional request", async () => {
  mocks.protocol = "moz-extension:"
  renderSettings()
  await waitForSignedOut()
  fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }))
  await waitFor(() => expectAuthCount(1))
  expect(mocks.permission).not.toHaveBeenCalled()
})
it("missing Firefox capability stops before authorization and preserves configured providers", async () => {
  mocks.protocol = "moz-extension:"
  mocks.installedPermission = false
  const store = renderSettings()
  const initial = store.get(configAtom)
  await waitForSignedOut()
  expect(mocks.permission).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }))
  await waitFor(() =>
    expect(screen.getByText("Sign-in permission was not granted.")).toBeInTheDocument(),
  )
  expectAuthCount(0)
  expect(store.get(configAtom)).toBe(initial)
  expect(screen.getByLabelText("BYOK API key")).toHaveValue("keep-my-key")
})
it("opening Add provider during a pending grant leaves the dedicated sign-in cancellable", async () => {
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
  const dialog = await screen.findByRole("dialog")
  expect(within(dialog).queryByRole("button", { name: "ChatGPT" })).not.toBeInTheDocument()
  expect(mocks.permission).toHaveBeenCalledOnce()
  fireEvent.keyDown(dialog, { key: "Escape" })
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  await waitForSignedOut()
  await act(async () => release(true))
  expectAuthCount(0)
})

it("restores an existing pending sign-in when settings opens and refreshes its completed account", async () => {
  mocks.send.mockResolvedValue({
    state: "disconnected",
    authPending: true,
    authAttemptId: pendingAttemptId,
  })
  renderSettings()
  await waitFor(() =>
    expect(screen.getByText("Complete sign-in in the opened tab.")).toBeInTheDocument(),
  )
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled()
  expect(screen.queryByRole("button", { name: "Sign in with ChatGPT" })).not.toBeInTheDocument()
  expect(mocks.permission).not.toHaveBeenCalled()
  expectAuthCount(0)

  mockConnected()
  fireEvent(window, new Event("focus"))
  await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("synthetic-model"))
  expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
})

it("keeps an existing account's reconnect pending without discovering its old model catalog", async () => {
  mocks.send.mockImplementation(async (type) =>
    type === "lingotoriByosSession"
      ? { ...connected, authPending: true, authAttemptId: pendingAttemptId }
      : availableModels,
  )
  renderSettings()
  await waitFor(() =>
    expect(screen.getByText("Complete sign-in in the opened tab.")).toBeInTheDocument(),
  )
  expect(mocks.send).not.toHaveBeenCalledWith("lingotoriByosModels", undefined)
  expect(screen.queryByLabelText("Model")).not.toBeInTheDocument()
  expect(mocks.permission).not.toHaveBeenCalled()
})

it("restores the connected account's saved model after cancelling a reconnect recovered on mount", async () => {
  let authPending = true
  mocks.send.mockImplementation(async (type) => {
    if (type === "lingotoriByosSession")
      return { ...connected, authPending, authAttemptId: pendingAttemptId }
    if (type === "lingotoriByosCancelAuth") {
      authPending = false
      return undefined
    }
    if (type === "lingotoriByosModels")
      return {
        models: [
          ...availableModels.models,
          { slug: "historical-model", display_name: "Saved Account Model" },
        ],
      }
    return undefined
  })
  const store = renderSettings(),
    initial = store.get(configAtom)
  await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled())
  expect(mocks.send).not.toHaveBeenCalledWith("lingotoriByosModels", undefined)

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  // No focus event or reopen should be needed to use the preserved account.
  await waitFor(() => expect(screen.getByLabelText("Model")).toBeEnabled())
  expect(screen.getByLabelText("Model")).toHaveValue("historical-model")
  expect(screen.getByRole("button", { name: "Save model" })).toBeEnabled()
  expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  expect(mocks.send.mock.calls.filter(([type]) => type === "lingotoriByosSession")).toHaveLength(2)
  expect(mocks.send.mock.calls.filter(([type]) => type === "lingotoriByosModels")).toHaveLength(1)
  expect(mocks.permission).not.toHaveBeenCalled()
  expectAuthCount(0)
  expect(store.get(configAtom)).toBe(initial)
})

it("preserves an unsaved model choice when returning to settings refreshes discovery", async () => {
  mocks.send.mockImplementation(async (type) =>
    type === "lingotoriByosSession"
      ? connected
      : type === "lingotoriByosModels"
        ? {
            models: [
              ...availableModels.models,
              { slug: "second-model", display_name: "Second Model" },
            ],
          }
        : undefined,
  )
  const store = renderSettings(),
    initial = store.get(configAtom)
  await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("synthetic-model"))
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "second-model" } })
  fireEvent(window, new Event("focus"))
  await waitFor(() =>
    expect(mocks.send.mock.calls.filter(([type]) => type === "lingotoriByosModels")).toHaveLength(
      2,
    ),
  )
  await waitFor(() => expect(screen.getByLabelText("Model")).toBeEnabled())
  expect(screen.getByLabelText("Model")).toHaveValue("second-model")
  expect(store.get(configAtom)).toBe(initial)
  expect(mocks.permission).not.toHaveBeenCalled()
})

it("cancels its restored attempt identifier even if another settings page has started a newer attempt", async () => {
  const replacementId = "22222222-2222-4222-8222-222222222222"
  let currentId = pendingAttemptId
  mocks.send.mockImplementation(async (type) =>
    type === "lingotoriByosSession"
      ? { ...connected, authPending: true, authAttemptId: currentId }
      : undefined,
  )
  const store = renderSettings(),
    initial = store.get(configAtom)
  await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled())
  currentId = replacementId
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith("lingotoriByosCancelAuth", pendingAttemptId),
  )
  await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled())
  expect(screen.getByText("Complete sign-in in the opened tab.")).toBeInTheDocument()
  expectAuthCount(0)
  expect(mocks.permission).not.toHaveBeenCalled()
  expect(store.get(configAtom)).toBe(initial)
})

it.each(["rejected", "timeout"])(
  "restores model catalog after cancellation cleanup %s",
  async (mode) => {
    let authPending = true
    mocks.send.mockImplementation(async (type) => {
      if (type === "lingotoriByosSession")
        return { ...connected, authPending, authAttemptId: pendingAttemptId }
      if (type === "lingotoriByosCancelAuth") {
        authPending = false
        if (mode === "timeout") return new Promise<never>(() => {})
        throw new Error("Synthetic cleanup failure")
      }
      if (type === "lingotoriByosModels")
        return { models: [{ slug: "historical-model", display_name: "Saved Account Model" }] }
      return undefined
    })
    const store = renderSettings(),
      initial = store.get(configAtom)
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled())
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(mode === "timeout" ? 10001 : 1)
    })
    vi.useRealTimers()
    await waitFor(() => expect(screen.getByLabelText("Model")).toBeEnabled())
    expect(screen.getByLabelText("Model")).toHaveValue("historical-model")
    expect(screen.getByRole("button", { name: "Save model" })).toBeEnabled()
    expect(screen.getByText("Could not connect. Try again.")).toBeInTheDocument()
    expect(store.get(configAtom)).toBe(initial)
    expect(mocks.permission).not.toHaveBeenCalled()
  },
)

async function beginFirstConnection() {
  const store = renderSettings(false)
  await waitForSignedOut()
  fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }))
  await waitFor(() =>
    expect(screen.getByText("Complete sign-in in the opened tab.")).toBeInTheDocument(),
  )
  return store
}

describe("first ChatGPT connection defaults", () => {
  it("persists the discovered model and compatible empty assignments after an explicit connection", async () => {
    const store = await beginFirstConnection()
    expect(store.get(configAtom).providersConfig).toEqual([])
    mockConnected()
    fireEvent(window, new Event("focus"))
    await waitFor(() =>
      expect(store.get(configAtom).pageTranslation.providerId).toBe("lingotori-byos"),
    )
    const config = store.get(configAtom)
    expect(config.providersConfig).toEqual([
      expect.objectContaining({
        provider: "byos",
        model: expect.objectContaining({ customModel: "synthetic-model" }),
      }),
    ])
    expect(config.videoSubtitles.providerId).toBe("lingotori-byos")
    expect(config.selectionToolbar.features.translate.providerId).toBe("lingotori-byos")
    expect(config.selectionToolbar.builtInActions.dictionary.providerId).toBe("lingotori-byos")
    expect(config.selectionToolbar.builtInActions.sentenceAnalysis.providerId).toBe(
      "lingotori-byos",
    )
    expect(config.languageDetection).toEqual(DEFAULT_CONFIG.languageDetection)
  })
  it("does not persist an already connected account merely by opening settings", async () => {
    mockConnected()
    const store = renderSettings(false)
    const initial = store.get(configAtom)
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("synthetic-model"))
    expect(store.get(configAtom)).toBe(initial)
    fireEvent.click(screen.getByRole("button", { name: "Save model" }))
    await waitFor(() =>
      expect(store.get(configAtom).pageTranslation.providerId).toBe("lingotori-byos"),
    )
  })
  it("leaves empty assignments alone if another provider registers before discovery completes", async () => {
    const store = await beginFirstConnection()
    let release!: (value: unknown) => void
    const catalog = new Promise((resolve) => {
      release = resolve
    })
    mocks.send.mockImplementation(async (type) =>
      type === "lingotoriByosSession"
        ? connected
        : type === "lingotoriByosModels"
          ? catalog
          : undefined,
    )
    fireEvent(window, new Event("focus"))
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("lingotoriByosModels", undefined))
    act(() =>
      store.set(configAtom, {
        ...store.get(configAtom),
        providersConfig: [structuredClone(DEFAULT_PROVIDER_CONFIG.openai)],
      }),
    )
    const registered = store.get(configAtom)
    await act(async () => release(availableModels))
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("synthetic-model"))
    expect(store.get(configAtom)).toEqual(registered)
  })
  it("does not register after cancellation discards a late catalog", async () => {
    const store = await beginFirstConnection()
    let release!: (value: unknown) => void
    const catalog = new Promise((resolve) => {
      release = resolve
    })
    mocks.send.mockImplementation(async (type) =>
      type === "lingotoriByosSession"
        ? connected
        : type === "lingotoriByosModels"
          ? catalog
          : undefined,
    )
    fireEvent(window, new Event("focus"))
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("lingotoriByosModels", undefined))
    await openAccountMenu()
    mocks.send.mockImplementation(async (type) =>
      type === "lingotoriByosSignout" || type === "lingotoriByosSession"
        ? { state: "disconnected" }
        : undefined,
    )
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }))
    await waitForSignedOut()
    await act(async () => release(availableModels))
    expect(store.get(configAtom).providersConfig).toEqual([])
  })
  it.each(["empty", "failed"])("does not register with a %s model catalog", async (mode) => {
    const store = await beginFirstConnection()
    mocks.send.mockImplementation(async (type) => {
      if (type === "lingotoriByosSession") return connected
      if (type === "lingotoriByosModels") {
        if (mode === "failed") throw new Error("Synthetic catalog unavailable")
        return { models: [] }
      }
      return undefined
    })
    fireEvent(window, new Event("focus"))
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("lingotoriByosModels", undefined))
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: mode === "failed" ? "Try again" : "Save model" }),
      ).toBeInTheDocument(),
    )
    expect(store.get(configAtom).providersConfig).toEqual([])
  })
})

it("keeps first-connection assignments unsaved when persistence fails and allows model-save recovery", async () => {
  const store = await beginFirstConnection()
  mocks.writeFailure = true
  mockConnected()
  fireEvent(window, new Event("focus"))
  await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled())
  expect(store.get(configAtom).providersConfig).toEqual([])
  expect(store.get(configAtom).pageTranslation).toEqual(DEFAULT_CONFIG.pageTranslation)
  mocks.writeFailure = false
  fireEvent.click(screen.getByRole("button", { name: "Try again" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Save model" })).toBeEnabled())
  expect(store.get(configAtom).providersConfig).toEqual([])
  fireEvent.click(screen.getByRole("button", { name: "Save model" }))
  await waitFor(() =>
    expect(store.get(configAtom).pageTranslation.providerId).toBe("lingotori-byos"),
  )
})
