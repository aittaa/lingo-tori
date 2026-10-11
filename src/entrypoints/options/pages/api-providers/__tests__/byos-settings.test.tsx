// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { configAtom } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { ApiProvidersPage } from ".."

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
    writeConfigAtom: atom(
      null,
      (get, set, update: (config: typeof initialConfig) => Partial<typeof initialConfig>) => {
        set(testConfigAtom, { ...get(testConfigAtom), ...update(get(testConfigAtom)) })
      },
    ),
  }
})
vi.mock("../providers-config", () => ({
  ProvidersConfig: () => (
    <label>
      BYOK API key
      <input defaultValue="keep-my-key" />
    </label>
  ),
}))
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
afterEach(cleanup)

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

describe("experimental browser-only BYOS within API Providers", () => {
  it("requests callback permission only on explicit continue and preserves BYOK", async () => {
    const store = renderSettings(),
      initial = store.get(configAtom)
    expect(
      screen.getByRole("heading", { name: "Sign in with ChatGPT · Experimental BYOS" }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Live sign-in, callback routing and inference have not been verified/),
    ).toBeInTheDocument()
    expect(mocks.permission).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalledWith("lingotoriByosAuth", undefined)
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }))
    expect(mocks.permission).toHaveBeenCalledOnce()
    expect(mocks.permission).toHaveBeenCalledWith({
      permissions: ["declarativeNetRequestWithHostAccess"],
    })
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("lingotoriByosAuth", undefined))
    expect(screen.queryByLabelText("Companion address")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Local pairing secret")).not.toBeInTheDocument()
    expect(screen.getByLabelText("BYOK API key")).toHaveValue("keep-my-key")
    expect(store.get(configAtom)).toBe(initial)
  })
  it("does not start auth after optional permission is denied", async () => {
    mocks.permission.mockResolvedValue(false)
    renderSettings()
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeEnabled(),
    )
    expect(mocks.send).not.toHaveBeenCalledWith("lingotoriByosAuth", undefined)
  })
  it("shows Firefox as unavailable without requesting an undeclared permission", () => {
    mocks.chromium = false
    renderSettings()
    expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeDisabled()
    expect(screen.getByText(/requires a Chromium browser/)).toBeInTheDocument()
    expect(mocks.permission).not.toHaveBeenCalled()
  })
  it.each([
    ["ko", "ChatGPT로 계속"],
    ["ja", "ChatGPT で続行"],
  ])("localizes sign-in in %s", (locale, label) => {
    mocks.locale = locale
    renderSettings()
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument()
    expect(mocks.permission).not.toHaveBeenCalled()
  })
  it("cannot restore late model results after local logout", async () => {
    let release!: (value: unknown) => void
    const models = new Promise((resolve) => {
      release = resolve
    })
    mocks.send.mockImplementation(async (type) => {
      if (type === "lingotoriByosSession") return { state: "plan-enabled" }
      if (type === "lingotoriByosModels") return models
      return undefined
    })
    renderSettings()
    fireEvent.click(screen.getByRole("button", { name: "Refresh connection and models" }))
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("lingotoriByosModels", undefined))
    fireEvent.click(screen.getByRole("button", { name: "Sign out of ChatGPT" }))
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("lingotoriByosSignout", undefined))
    release({ models: [{ slug: "late-model", display_name: "Late Model" }] })
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: "Late Model" })).not.toBeInTheDocument(),
    )
    expect(screen.getByRole("button", { name: "Save BYOS provider" })).toBeDisabled()
  })
})

it("does not reopen login when a permission grant arrives after logout", async () => {
  let release!: (value: boolean) => void
  mocks.permission.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve
    }),
  )
  mocks.dnrAvailable = false
  renderSettings()
  expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeEnabled()
  fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }))
  fireEvent.click(screen.getByRole("button", { name: "Sign out of ChatGPT" }))
  await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("lingotoriByosSignout", undefined))
  mocks.dnrAvailable = true
  release(true)
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeEnabled(),
  )
  expect(mocks.send).not.toHaveBeenCalledWith("lingotoriByosAuth", undefined)
})
it.each(["reconnect-required", "limit-reached", "restricted"])(
  "recovers the actual %s status after discovery fails",
  async (state) => {
    let sessions = 0
    mocks.send.mockImplementation(async (type) => {
      if (type === "lingotoriByosSession")
        return { state: ++sessions <= 2 ? "plan-enabled" : state }
      if (type === "lingotoriByosModels") throw new Error("synthetic rejected request")
      return undefined
    })
    renderSettings()
    fireEvent.click(screen.getByRole("button", { name: "Refresh connection and models" }))
    await waitFor(() =>
      expect(screen.queryByText("ChatGPT plan access enabled")).not.toBeInTheDocument(),
    )
    expect(screen.getByRole("button", { name: "Save BYOS provider" })).toBeDisabled()
    expect(screen.getByRole("link", { name: "Manage ChatGPT usage" })).toHaveAttribute(
      "href",
      "https://chatgpt.com/#settings/Usage",
    )
  },
)
it("reports confirmed remote revocation only when the response confirms it", async () => {
  mocks.send.mockImplementation(async (type) =>
    type === "lingotoriByosSignout"
      ? { state: "disconnected", remoteRevocationConfirmed: true }
      : { state: "disconnected" },
  )
  renderSettings()
  fireEvent.click(screen.getByRole("button", { name: "Sign out of ChatGPT" }))
  await waitFor(() => expect(screen.getByText("Signed out of ChatGPT.")).toBeInTheDocument())
})
