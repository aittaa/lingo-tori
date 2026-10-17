// @vitest-environment jsdom
//
// The ChatGPT sign-in button on the settings page. On Firefox, pressing it asks for the
// `authenticationInfo` consent in the same turn as the click (before anything is awaited), exactly
// where Chromium's callback permission is asked, and the sign-in message goes to the background only
// once the user has allowed it. Declined: nothing is sent and the page says so. A Chrome build asks
// nothing. A session that loses its consent is told apart from a broken connection.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DataConsentRequiredError } from "@/utils/firefox-data-consent"
import {
  installChrome,
  installFirefox,
  NOTHING_GRANTED,
  removePermissionsDouble,
  WITH_CREDENTIALS,
} from "./firefox-permissions"

const messages = vi.hoisted(() => ({
  send: vi.fn<(type: string, data?: unknown) => Promise<unknown>>(),
}))

vi.mock("@/utils/byos/messages", () => ({ sendByosMessage: messages.send }))
vi.mock("@/utils/byos/browser", () => ({ isByosExtensionUrl: () => true }))
vi.mock("@/utils/byos/permissions", () => ({
  requestByosCallbackPermission: vi.fn<() => Promise<boolean>>(async () => true),
}))
vi.mock("@/utils/atoms/config", async () => {
  const { atom } = await import("jotai")
  const { DEFAULT_CONFIG: defaults } = await import("@/utils/constants/config")
  return { configAtom: atom(defaults), writeConfigAtom: atom(null, async () => {}) }
})

// The component is imported after the mocks above are in place.
const { ByosSettings } = await import("@/entrypoints/options/pages/byos")

function mount() {
  const store = createStore()
  return render(createElement(Provider, { store }, createElement(ByosSettings)))
}

beforeEach(() => {
  messages.send.mockReset()
  messages.send.mockImplementation(async (type) => {
    if (type === "lingotoriByosSession") return { state: "disconnected", authPending: false }
    return undefined
  })
})

afterEach(() => {
  cleanup()
  removePermissionsDouble()
})

const SIGN_IN = "Sign in with ChatGPT"
const sentAuthStart = () => messages.send.mock.calls.some(([type]) => type === "lingotoriByosAuth")

describe("the sign-in button on Firefox", () => {
  it("asks for the data consent in the click itself, before any await", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)
    mount()
    const button = await screen.findByRole("button", { name: SIGN_IN })
    await waitFor(() => expect(button).toBeEnabled())

    fireEvent.click(button)

    expect(permissions.request).toHaveBeenCalledTimes(1)
    expect(permissions.request).toHaveBeenCalledWith({ data_collection: ["authenticationInfo"] })
  })

  it("starts the sign-in only after the user has allowed it", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)
    permissions.answerPrompts(true)
    mount()
    const button = await screen.findByRole("button", { name: SIGN_IN })
    await waitFor(() => expect(button).toBeEnabled())

    fireEvent.click(button)

    await waitFor(() => expect(sentAuthStart()).toBe(true))
  })

  it("sends nothing when the user declines, and says so", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)
    permissions.answerPrompts(false)
    mount()
    const button = await screen.findByRole("button", { name: SIGN_IN })
    await waitFor(() => expect(button).toBeEnabled())

    fireEvent.click(button)

    expect(await screen.findByText(/Firefox permission to send sign-in data/)).toBeInTheDocument()
    expect(sentAuthStart()).toBe(false)
  })

  it("shows where the consent stands for a connected account, with its own button", async () => {
    installFirefox(NOTHING_GRANTED)
    messages.send.mockImplementation(async (type) => {
      if (type === "lingotoriByosSession")
        return { state: "plan-enabled", account: { email: "a@b.test" } }
      if (type === "lingotoriByosModels") return { models: [] }
      return undefined
    })
    mount()

    expect(await screen.findByText("dataConsent.status.denied")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "dataConsent.allow" })).toBeInTheDocument()
  })

  it("keeps the row out of the way before an account is connected: the sign-in click asks", async () => {
    installFirefox(NOTHING_GRANTED)
    mount()
    await screen.findByRole("button", { name: SIGN_IN })

    expect(screen.queryByText("dataConsent.status.denied")).not.toBeInTheDocument()
  })

  it("starts the sign-in when the consent is already granted", async () => {
    const permissions = installFirefox(WITH_CREDENTIALS)
    permissions.answerPrompts(true)
    mount()
    const button = await screen.findByRole("button", { name: SIGN_IN })
    await waitFor(() => expect(button).toBeEnabled())

    fireEvent.click(button)

    await waitFor(() => expect(sentAuthStart()).toBe(true))
  })
})

describe("a session whose consent went away", () => {
  it("is told apart from a broken connection", async () => {
    installFirefox(NOTHING_GRANTED)
    messages.send.mockImplementation(async (type) => {
      if (type === "lingotoriByosSession")
        return { state: "plan-enabled", account: { email: "a@b.test" } }
      if (type === "lingotoriByosModels")
        throw new DataConsentRequiredError("authenticationInfo", "denied")
      return undefined
    })

    mount()

    expect(
      await screen.findByText(/Firefox data consent is needed to send sign-in data/),
    ).toBeInTheDocument()
    expect(screen.queryByText("Could not connect. Try again.")).not.toBeInTheDocument()
  })
})

describe("the sign-in button on Chrome", () => {
  it("starts the sign-in without asking the browser for consent, and shows no consent row", async () => {
    const permissions = installChrome()
    mount()
    const button = await screen.findByRole("button", { name: SIGN_IN })
    await waitFor(() => expect(button).toBeEnabled())

    await act(async () => {
      fireEvent.click(button)
    })

    await waitFor(() => expect(sentAuthStart()).toBe(true))
    expect(permissions.browserCalls()).toBe(0)
    expect(screen.queryByText("dataConsent.status.denied")).not.toBeInTheDocument()
  })
})
