// @vitest-environment jsdom
//
// "Fetch models" in the provider settings sends the user's API key to the provider's /models
// endpoint, straight from the options page rather than through the shared provider fetch. On a
// Firefox build it is a credentialed transmission like any other: it must not start while
// `authenticationInfo` is not granted, and the user is told the request failed so they can retry.
//
// This test does not import the consent module: on the base commit the key is sent.

import type { ProtocolCompatibleLLMProviderConfig } from "@/types/config/provider"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ModelSuggestionButton } from "@/entrypoints/options/pages/api-providers/providers-config/provider-config-form/components/model-suggestion-button"
import {
  installChrome,
  installFirefox,
  removePermissionsDouble,
  NOTHING_GRANTED,
  WITH_CREDENTIALS,
} from "./firefox-permissions"

const FETCH_MODELS = "options.apiProviders.form.models.fetchModels"
const RETRY = "options.apiProviders.form.models.clickToRetry"
const SELECT_MODEL = "options.apiProviders.form.models.selectModel"

const providerConfig = {
  id: "openai-compatible-test",
  name: "Custom endpoint",
  enabled: true,
  provider: "openai-compatible",
  baseURL: "https://provider.example.test/v1",
  apiKey: "sk-test-123",
  model: { model: "use-custom-model", isCustomModel: true, customModel: "mock-model" },
} as ProtocolCompatibleLLMProviderConfig

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () =>
    Response.json({
      object: "list",
      data: [{ id: "model-a", object: "model", created: 1, owned_by: "x" }],
    }),
  )
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  removePermissionsDouble()
})

function renderButton() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ModelSuggestionButton providerConfig={providerConfig} onSelect={() => {}} />
    </QueryClientProvider>,
  )
}

const clickFetchModels = () => fireEvent.click(screen.getByRole("button", { name: FETCH_MODELS }))

/** The request has finished one way or the other: a retry offer, or the list of models. */
const settled = () => screen.findByText(new RegExp(`${RETRY}|${SELECT_MODEL}`))

describe("Fetch models on Firefox", () => {
  it("does not send the key while authenticationInfo is not granted, and offers a retry", async () => {
    installFirefox(NOTHING_GRANTED)
    renderButton()

    clickFetchModels()

    await settled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: RETRY })).toBeInTheDocument()
  })

  it("fails closed on a Firefox without built-in consent support", async () => {
    installFirefox(undefined)
    renderButton()

    clickFetchModels()

    await settled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: RETRY })).toBeInTheDocument()
  })

  it("sends the key and lists the models once granted", async () => {
    installFirefox(WITH_CREDENTIALS)
    renderButton()

    clickFetchModels()

    await screen.findByText(SELECT_MODEL)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://provider.example.test/v1/models")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test-123")
  })

  it("honours a grant made after a refused attempt when the user retries, with no restart", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)
    renderButton()
    clickFetchModels()
    await settled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: RETRY })).toBeInTheDocument()

    permissions.report(WITH_CREDENTIALS)
    fireEvent.click(screen.getByRole("button", { name: RETRY }))

    await screen.findByText(SELECT_MODEL)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("Fetch models on Chrome", () => {
  it("sends the key and never asks the browser for consent", async () => {
    const permissions = installChrome()
    renderButton()

    clickFetchModels()

    await screen.findByText(SELECT_MODEL)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(permissions.browserCalls()).toBe(0)
  })
})
