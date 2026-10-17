// @vitest-environment node
//
// Provider requests that carry a credential, on a Firefox build, against the real model
// factories, `generateText` and the DeepL and DeepLX adapters, with a stubbed `fetch`.
//
// The contract: a request that carries an EXPLICIT credential is a transmission of
// `authenticationInfo`. On Firefox it starts only while that category is granted; the grant is read
// for every new request, so a revocation in about:addons stops the next request, a retry included.
//
// What counts as an explicit credential: a non-empty API key (or the `{{apiKey}}` placeholder); a
// header whose name is a credential name (authorization, proxy-authorization, cookie, x-api-key,
// api-key, or a name containing token, secret, key or auth); userinfo in the URL; a credential-named
// query parameter; or the user's own declaration that the endpoint URL or options hold a credential.
// A custom endpoint with none of those is keyless and keeps working without the grant. A secret
// hidden in an opaque URL path or option cannot be detected, which is why the declaration exists.
//
// A Chrome build is never gated and never asks the browser anything. A request whose fetch already
// started may complete: only new requests are stopped.
//
// These tests do not import the consent module, so on the base commit they fail because the
// credentialed request is sent, not because something is missing.

import type { LLMProviderConfig } from "@/types/config/provider"
import { generateText } from "ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { deeplTranslate } from "@/utils/host/translate/api/deepl"
import { deeplxTranslate } from "@/utils/host/translate/api/deeplx"
import { getLanguageModelForConfig } from "@/utils/providers/model"
import {
  installChrome,
  installFirefox,
  removePermissionsDouble,
  NOTHING_GRANTED,
  WITH_CREDENTIALS,
} from "./firefox-permissions"

const ORIGIN = "https://provider.example.test"
const MODEL = { model: "use-custom-model", isCustomModel: true, customModel: "mock-model" } as const

const CHAT_COMPLETION = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1,
  model: "mock-model",
  choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}
const OLLAMA_CHAT = {
  model: "mock-model",
  created_at: "2026-01-01T00:00:00Z",
  message: { role: "assistant", content: "pong" },
  done: true,
  done_reason: "stop",
  total_duration: 1,
  load_duration: 1,
  prompt_eval_count: 1,
  prompt_eval_duration: 1,
  eval_count: 1,
  eval_duration: 1,
}

const RESPONSES_RESULT = {
  id: "resp-test",
  object: "response",
  created_at: 1,
  status: "completed",
  model: "mock-model",
  output: [
    {
      type: "message",
      id: "msg-test",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "pong", annotations: [] }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function urlOf(input: RequestInfo | URL) {
  if (typeof input === "string") return input
  return input instanceof URL ? input.href : input.url
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input) => {
    const url = urlOf(input)
    if (url.endsWith("/chat/completions")) return jsonResponse(CHAT_COMPLETION)
    if (url.endsWith("/api/chat")) return jsonResponse(OLLAMA_CHAT)
    if (url.endsWith("/responses")) return jsonResponse(RESPONSES_RESULT)
    if (url.endsWith("/v2/translate")) return jsonResponse({ translations: [{ text: "Bonjour" }] })
    if (url.includes("deeplx")) return jsonResponse({ code: 200, data: "Bonjour" })
    return new Response("not found", { status: 404 })
  })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  removePermissionsDouble()
})

type Send = () => Promise<unknown>

const llm =
  (config: LLMProviderConfig, maxRetries = 0): Send =>
  () =>
    generateText({
      model: getLanguageModelForConfig(config, "pageTranslation"),
      prompt: "ping",
      maxRetries,
    })

const openAICompatible = (extra: Record<string, unknown> = {}) =>
  ({
    id: "openai-compatible-test",
    name: "Custom endpoint",
    enabled: true,
    provider: "openai-compatible",
    baseURL: `${ORIGIN}/v1`,
    model: MODEL,
    ...extra,
  }) as unknown as LLMProviderConfig

const openResponses = (extra: Record<string, unknown> = {}) =>
  ({
    id: "open-responses-test",
    name: "Custom endpoint",
    enabled: true,
    provider: "open-responses",
    url: `${ORIGIN}/v1/responses`,
    model: MODEL,
    ...extra,
  }) as unknown as LLMProviderConfig

const withKey = openAICompatible({ apiKey: "sk-test-123" })
const deepseekWithKey = {
  id: "deepseek-test",
  name: "DeepSeek",
  enabled: true,
  provider: "deepseek",
  baseURL: `${ORIGIN}/v1`,
  apiKey: "sk-test-123",
  model: { model: "deepseek-v4-flash", isCustomModel: true, customModel: "mock-model" },
} as LLMProviderConfig
const anthropicWithKey = {
  ...DEFAULT_PROVIDER_CONFIG.anthropic,
  baseURL: ORIGIN,
  apiKey: "sk-test-123",
} as LLMProviderConfig
const googleWithKey = {
  ...DEFAULT_PROVIDER_CONFIG.google,
  baseURL: ORIGIN,
  apiKey: "sk-test-123",
} as LLMProviderConfig
const authHeaderOnly = openAICompatible({ headers: { Authorization: "Bearer sk-from-header" } })
const ollama = {
  id: "ollama-test",
  name: "Ollama",
  enabled: true,
  provider: "ollama",
  baseURL: ORIGIN,
  model: { model: "gemma3:4b", isCustomModel: true, customModel: "mock-model" },
} as LLMProviderConfig
const ordinaryHeaderOnly = openAICompatible({ headers: { "X-Title": "LingoTori" } })

const deepl = {
  id: "deepl-test",
  name: "DeepL",
  enabled: true,
  provider: "deepl",
  apiKey: "test-key:fx",
} as const
const deeplx = {
  id: "deeplx-test",
  name: "DeepLX",
  enabled: true,
  provider: "deeplx",
  baseURL: "https://deeplx.example.test/translate",
} as const
const deeplxKeyInUrl = {
  ...deeplx,
  baseURL: "https://deeplx.example.test/{{apiKey}}/translate",
  apiKey: "deeplx-secret",
} as const

const sendDeepL: Send = () =>
  deeplTranslate("Hello", "auto", "fr", deepl, { usageFeature: "pageTranslation" })
const sendDeepLX: Send = () =>
  deeplxTranslate("Hello", "auto", "fr", deeplx, { usageFeature: "pageTranslation" })
const sendDeepLXKeyInUrl: Send = () =>
  deeplxTranslate("Hello", "auto", "fr", deeplxKeyInUrl, { usageFeature: "pageTranslation" })

/** Requests that carry a credential: the key reaches the wire in a header or in the URL. */
const CREDENTIALED: Array<[string, Send]> = [
  ["openai-compatible with an API key", llm(withKey)],
  ["deepseek with an API key", llm(deepseekWithKey)],
  ["anthropic with an API key (x-api-key)", llm(anthropicWithKey)],
  ["google with an API key (x-goog-api-key)", llm(googleWithKey)],
  ["openai-compatible with a custom Authorization header and no key", llm(authHeaderOnly)],
  ["DeepL", sendDeepL],
  ["DeepLX with the key inside the URL", sendDeepLXKeyInUrl],
]

/** Requests that carry no credential at all (#89: custom endpoints without a key keep working). */
const KEYLESS: Array<[string, Send]> = [
  ["ollama on a local endpoint", llm(ollama)],
  ["a custom openai-compatible endpoint with nothing but a model", llm(openAICompatible())],
  ["a custom open-responses endpoint with nothing but a model", llm(openResponses())],
  ["openai-compatible with no key and only an ordinary header", llm(ordinaryHeaderOnly)],
  ["DeepLX on a plain URL", sendDeepLX],
]

/** Credentialed requests whose canned response the stub can answer, for the allowed cases. */
const CREDENTIALED_ANSWERABLE: Array<[string, Send]> = [
  ["openai-compatible with an API key", llm(withKey)],
  ["deepseek with an API key", llm(deepseekWithKey)],
  ["openai-compatible with a custom Authorization header and no key", llm(authHeaderOnly)],
  ["DeepL", sendDeepL],
  ["DeepLX with the key inside the URL", sendDeepLXKeyInUrl],
]

/** Run one request and report how it ended: "sent", or the error that stopped it. */
async function attempt(send: Send) {
  return send().then(
    () => "sent" as const,
    (error: unknown) => error,
  )
}

describe("Firefox, authenticationInfo not granted (the state after install)", () => {
  it.each(CREDENTIALED)("sends nothing for %s", async (_name, send) => {
    installFirefox(NOTHING_GRANTED)

    const outcome = await attempt(send)

    expect(fetchMock).not.toHaveBeenCalled()
    // The user must be told about consent, not about a network failure.
    expect(outcome).toMatchObject({ name: "DataConsentRequiredError" })
  })

  it("does not count the required category as a grant, if the browser lists it", async () => {
    installFirefox(["websiteContent"])

    const outcome = await attempt(llm(withKey))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ name: "DataConsentRequiredError" })
  })

  it.each(KEYLESS)("still sends %s, which carries no credential", async (_name, send) => {
    const permissions = installFirefox(NOTHING_GRANTED)

    await expect(send()).resolves.toBeDefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(permissions.browserCalls()).toBe(0)
  })
})

describe("what counts as a credential, with authenticationInfo not granted", () => {
  it.each([
    "Authorization",
    "Proxy-Authorization",
    "Cookie",
    "X-Api-Key",
    "api-key",
    "X-Session-Token",
    "X-Client-Secret",
    "X-Custom-Auth",
    "X-Access-Key",
  ])("a configured %s header is a credential", async (name) => {
    installFirefox(NOTHING_GRANTED)

    const outcome = await attempt(llm(openAICompatible({ headers: { [name]: "value-1" } })))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ name: "DataConsentRequiredError" })
  })

  it.each([
    "X-Title",
    "HTTP-Referer",
    "anthropic-version",
    "X-Request-Id",
    "OpenAI-Organization",
    "Accept-Language",
  ])("a configured %s header is not a credential", async (name) => {
    installFirefox(NOTHING_GRANTED)

    await expect(llm(openAICompatible({ headers: { [name]: "value-1" } }))()).resolves.toBeDefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("userinfo in the endpoint URL is a credential", async () => {
    installFirefox(NOTHING_GRANTED)

    const outcome = await attempt(
      llm(openAICompatible({ baseURL: "https://user:secret@provider.example.test/v1" })),
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ name: "DataConsentRequiredError" })
  })

  it("a credential-named query parameter in the endpoint URL is a credential", async () => {
    installFirefox(NOTHING_GRANTED)

    const outcome = await attempt(
      llm(openAICompatible({ baseURL: `${ORIGIN}/v1?api_key=sk-test-123` })),
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ name: "DataConsentRequiredError" })
  })

  it("an ordinary query parameter such as api-version is not", async () => {
    installFirefox(NOTHING_GRANTED)

    await expect(
      llm(openAICompatible({ baseURL: `${ORIGIN}/v1?api-version=2024-02-01` }))(),
    ).resolves.toBeDefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("the user's declaration that the endpoint holds a credential gates a request that shows none", async () => {
    installFirefox(NOTHING_GRANTED)
    // A key typed into the path cannot be told from a path segment: the user says so.
    const declared = openAICompatible({
      baseURL: `${ORIGIN}/v1/KEY-IN-PATH-123`,
      endpointCarriesCredential: true,
    })

    const outcome = await attempt(llm(declared))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ name: "DataConsentRequiredError" })
  })

  it("a declared endpoint is sent once the category is granted", async () => {
    installFirefox(WITH_CREDENTIALS)

    await expect(
      llm(
        openAICompatible({
          baseURL: `${ORIGIN}/v1/KEY-IN-PATH-123`,
          endpointCarriesCredential: true,
        }),
      )(),
    ).resolves.toBeDefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("declaring that there is no credential does not lift an explicit one", async () => {
    installFirefox(NOTHING_GRANTED)

    const outcome = await attempt(
      llm(openAICompatible({ apiKey: "sk-test-123", endpointCarriesCredential: false })),
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ name: "DataConsentRequiredError" })
  })

  // The documented limit: a secret inside an opaque path segment or option is invisible to any
  // check. The settings hint and the privacy notice tell the user to use the declaration.
  it("does not claim to detect an undeclared secret hidden in the URL path", async () => {
    installFirefox(NOTHING_GRANTED)

    await expect(
      llm(openAICompatible({ baseURL: `${ORIGIN}/v1/KEY-IN-PATH-123` }))(),
    ).resolves.toBeDefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("Firefox without built-in consent support (no data_collection key)", () => {
  it.each(CREDENTIALED)("fails closed for %s", async (_name, send) => {
    installFirefox(undefined)

    const outcome = await attempt(send)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ name: "DataConsentRequiredError" })
  })

  it.each(KEYLESS)("still sends %s", async (_name, send) => {
    installFirefox(undefined)

    await expect(send()).resolves.toBeDefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("Firefox, authenticationInfo granted", () => {
  it.each(CREDENTIALED_ANSWERABLE)("sends %s", async (_name, send) => {
    installFirefox(WITH_CREDENTIALS)

    await expect(send()).resolves.toBeDefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("recognises the grant whether or not the required category is listed beside it", async () => {
    installFirefox(["websiteContent", "authenticationInfo"])

    await expect(llm(withKey)()).resolves.toBeDefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("sends the request unchanged: the key still reaches the provider", async () => {
    installFirefox(WITH_CREDENTIALS)

    await llm(withKey)()

    const [url, init] = fetchMock.mock.calls[0]!
    expect(urlOf(url)).toBe(`${ORIGIN}/v1/chat/completions`)
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test-123")
    expect(init?.cache).toBe("no-store")
  })
})

describe("revoked in about:addons during the session", () => {
  it.each(CREDENTIALED_ANSWERABLE)(
    "the next request of %s is not sent, the earlier one was",
    async (_name, send) => {
      const permissions = installFirefox(WITH_CREDENTIALS)
      await send()
      expect(fetchMock).toHaveBeenCalledTimes(1)

      permissions.report(NOTHING_GRANTED)
      const outcome = await attempt(send)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(outcome).toMatchObject({ name: "DataConsentRequiredError" })
    },
  )

  it("a grant made later is honoured by the next request, with no restart", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)
    expect(await attempt(llm(withKey))).toMatchObject({ name: "DataConsentRequiredError" })
    expect(fetchMock).not.toHaveBeenCalled()

    permissions.report(WITH_CREDENTIALS)
    await expect(llm(withKey)()).resolves.toBeDefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("a retry that would start after the revocation is not sent", async () => {
    vi.useFakeTimers()
    const permissions = installFirefox(WITH_CREDENTIALS)
    // The first attempt fails with a retryable error; the user revokes while the SDK waits.
    fetchMock.mockImplementationOnce(async () => {
      permissions.report(NOTHING_GRANTED)
      return new Response("overloaded", { status: 503 })
    })

    const outcome = llm(withKey, 2)().then(
      () => "sent" as const,
      (error: unknown) => error,
    )
    await vi.advanceTimersByTimeAsync(30_000)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await outcome).toMatchObject({ name: "DataConsentRequiredError" })
  })
})

describe("Chrome build", () => {
  it.each([...CREDENTIALED_ANSWERABLE, ...KEYLESS])(
    "sends %s and never asks the browser for consent",
    async (_name, send) => {
      const permissions = installChrome()

      await expect(send()).resolves.toBeDefined()

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(permissions.browserCalls()).toBe(0)
    },
  )
})
