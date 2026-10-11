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
  mocks.send.mockReset()
  mocks.send.mockImplementation(async (type) => {
    if (type === "lingotoriByosStatus") return { configured: false, endpoint: "" }
    if (type === "lingotoriByosSession") return { state: "disconnected" }
    if (type === "lingotoriByosModels")
      return {
        models: [
          { slug: "model-a", display_name: "Model A" },
          { slug: "model-b", display_name: "Model B" },
        ],
      }
    if (type === "lingotoriByosSignout")
      return { state: "disconnected", remoteRevocationConfirmed: true }
    return undefined
  })
})
afterEach(cleanup)

function renderSettings(withSavedProvider = true) {
  const store = createStore()
  const config = structuredClone(DEFAULT_CONFIG)
  config.providersConfig = withSavedProvider
    ? [
        {
          ...structuredClone(DEFAULT_PROVIDER_CONFIG.byos),
          id: "my-byos",
          name: "My companion",
          model: { model: "use-custom-model", isCustomModel: true, customModel: "model-a" },
        },
      ]
    : []
  store.set(configAtom, config)
  render(
    <Provider store={store}>
      <ApiProvidersPage />
    </Provider>,
  )
  return store
}

async function pairAndCheck() {
  fireEvent.change(screen.getByLabelText("Companion address"), {
    target: { value: "http://127.0.0.1:4321" },
  })
  fireEvent.change(screen.getByLabelText("Local pairing secret"), {
    target: { value: "local-pairing-fixture-not-a-token" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }))
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Refresh connection and models" })).toBeEnabled(),
  )
  fireEvent.click(screen.getByRole("button", { name: "Refresh connection and models" }))
}

describe("BYOS within API Providers", () => {
  it("shows ChatGPT sign-in alongside BYOK with actionable prerequisites and no automatic login", async () => {
    const store = renderSettings(false)
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
    expect(store.get(configAtom).providersConfig).toEqual([])
    expect(mocks.send).toHaveBeenCalledWith("lingotoriByosStatus", undefined)
    expect(
      screen.getByRole("heading", { name: "Sign in with ChatGPT · Experimental BYOS" }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Live ChatGPT account sign-in and inference have not been verified/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Start your local companion and save its address and pairing secret/),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Save BYOS provider" })).toBeDisabled()
    expect(screen.getByLabelText("BYOK API key")).toHaveValue("keep-my-key")

    await pairAndCheck()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeEnabled(),
    )
    expect(screen.getByText(/Signed out/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }))
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("lingotoriByosAuth", undefined))
    expect(screen.getByLabelText("BYOK API key")).toHaveValue("keep-my-key")
  })

  it("assigns a discovered model and disables model actions again after sign-out", async () => {
    mocks.send.mockImplementation(async (type) => {
      if (type === "lingotoriByosStatus")
        return { configured: true, endpoint: "http://127.0.0.1:4321" }
      if (type === "lingotoriByosSession")
        return {
          state: "plan-enabled",
          account: { subject: "test-account", email: "reader@example.test" },
        }
      if (type === "lingotoriByosModels")
        return {
          models: [
            { slug: "model-a", display_name: "Model A" },
            { slug: "model-b", display_name: "Model B" },
          ],
        }
      if (type === "lingotoriByosSignout")
        return { state: "disconnected", remoteRevocationConfirmed: false }
      return undefined
    })
    const store = renderSettings()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh connection and models" })).toBeEnabled(),
    )
    expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Refresh connection and models" }))
    await waitFor(() => expect(screen.getByLabelText("Available model")).toBeEnabled())
    expect(screen.getByText(/reader@example.test/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Available model"), { target: { value: "model-b" } })
    fireEvent.click(screen.getByRole("button", { name: "Use for page translation" }))
    await waitFor(() => expect(store.get(configAtom).pageTranslation.providerId).toBe("my-byos"))
    expect(store.get(configAtom).providersConfig[0]).toMatchObject({
      name: "My companion",
      model: { customModel: "model-b" },
    })

    fireEvent.click(screen.getByRole("button", { name: "Sign out of ChatGPT" }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save BYOS provider" })).toBeDisabled(),
    )
    expect(screen.getByText(/remote revocation was not confirmed/)).toBeInTheDocument()
    expect(screen.getByLabelText("BYOK API key")).toHaveValue("keep-my-key")
  })

  it("offers reconnect for expired authorization and forgets only local pairing", async () => {
    mocks.send.mockImplementation(async (type) => {
      if (type === "lingotoriByosStatus")
        return { configured: true, endpoint: "http://127.0.0.1:4321" }
      if (type === "lingotoriByosSession") return { state: "reconnect-required" }
      return undefined
    })
    renderSettings()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh connection and models" })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole("button", { name: "Refresh connection and models" }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reconnect with ChatGPT" })).toBeEnabled(),
    )
    expect(screen.getByRole("button", { name: "Use for page translation" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Reconnect with ChatGPT" }))
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("lingotoriByosAuth", undefined))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Forget local pairing" })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole("button", { name: "Forget local pairing" }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeDisabled(),
    )
    expect(mocks.send).toHaveBeenCalledWith("lingotoriByosConfigure", null)
    expect(mocks.send).not.toHaveBeenCalledWith("lingotoriByosSignout", undefined)
  })

  it("keeps sign-in and model assignment disabled when a paired companion is unreachable", async () => {
    mocks.send.mockImplementation(async (type) => {
      if (type === "lingotoriByosStatus")
        return { configured: true, endpoint: "http://127.0.0.1:4321" }
      if (type === "lingotoriByosSession") throw new Error("companion_unreachable")
      return undefined
    })
    renderSettings()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh connection and models" })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole("button", { name: "Refresh connection and models" }))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Connection failed"))
    expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Save BYOS provider" })).toBeDisabled()
    expect(mocks.send).not.toHaveBeenCalledWith("lingotoriByosAuth", undefined)
  })

  it.each([
    ["reconnect-required", "Sign-in expired; reconnect required"],
    ["limit-reached", "Plan limit reached"],
    ["restricted", "Account access restricted"],
  ] as const)(
    "surfaces %s when model discovery changes account readiness",
    async (state, label) => {
      let sessionChecks = 0
      mocks.send.mockImplementation(async (type) => {
        if (type === "lingotoriByosStatus")
          return { configured: true, endpoint: "http://127.0.0.1:4321" }
        if (type === "lingotoriByosSession")
          return { state: ++sessionChecks === 1 ? "plan-enabled" : state }
        if (type === "lingotoriByosModels") throw new Error("discovery_blocked")
        return undefined
      })
      renderSettings()
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Refresh connection and models" })).toBeEnabled(),
      )
      fireEvent.click(screen.getByRole("button", { name: "Refresh connection and models" }))
      await waitFor(() => expect(screen.getByText(new RegExp(label))).toBeInTheDocument())
      expect(sessionChecks).toBe(2)
      expect(screen.getByRole("button", { name: "Save BYOS provider" })).toBeDisabled()
      expect(screen.queryByText(/ChatGPT plan access enabled/)).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Reconnect with ChatGPT" }) !== null).toBe(
        state === "reconnect-required",
      )
      expect(screen.getByRole("link", { name: "Manage ChatGPT usage" })).toBeInTheDocument()
      expect(mocks.send).not.toHaveBeenCalledWith("lingotoriByosAuth", undefined)
    },
  )

  it.each(["unreachable", "session-still-enabled"] as const)(
    "clears readiness after model failure with %s recovery",
    async (recovery) => {
      let sessionChecks = 0
      mocks.send.mockImplementation(async (type) => {
        if (type === "lingotoriByosStatus")
          return { configured: true, endpoint: "http://127.0.0.1:4321" }
        if (type === "lingotoriByosSession") {
          sessionChecks += 1
          if (sessionChecks > 1 && recovery === "unreachable")
            throw new Error("companion_unreachable")
          return { state: "plan-enabled" }
        }
        if (type === "lingotoriByosModels") throw new Error("companion_unreachable")
        return undefined
      })
      renderSettings()
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Refresh connection and models" })).toBeEnabled(),
      )
      fireEvent.click(screen.getByRole("button", { name: "Refresh connection and models" }))
      await waitFor(() =>
        expect(screen.getByText(/Companion or models temporarily unavailable/)).toBeInTheDocument(),
      )
      expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeDisabled()
      expect(screen.getByRole("button", { name: "Save BYOS provider" })).toBeDisabled()
      expect(screen.getByLabelText("Available model")).toBeDisabled()
      expect(screen.queryByText(/ChatGPT plan access enabled/)).not.toBeInTheDocument()
      expect(mocks.send).not.toHaveBeenCalledWith("lingotoriByosAuth", undefined)
    },
  )
})
