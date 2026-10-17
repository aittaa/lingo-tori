// @vitest-environment jsdom
//
// Custom actions can use the `{{webUrl}}` token in their prompt, their system prompt and their
// output-field descriptions, and the note suggestion is built from the same templates. When one of
// them does, the full URL of the page goes to the user's provider: that is `browsingActivity`, a
// separate optional category from `authenticationInfo`. On a Firefox build such a run starts only
// while `browsingActivity` is granted. A run whose templates never use the token sends no URL and
// needs neither optional category. Each category is checked on its own.
//
// Real: the hook, the plan builder, the content-side stream client, the background dispatcher and
// the structured-stream handler, the model factory, the AI SDK. Doubled: the port transport and the
// provider's network edge (shared helpers). The page URL is the test environment's own.
//
// These tests do not import the consent module: on the base commit the URL is sent.

import type { LLMProviderConfig } from "@/types/config/provider"
import type { CachedWebPageContext } from "@/utils/host/translate/webpage-context"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import {
  buildCustomActionExecutionPlan,
  useCustomActionExecution,
} from "@/components/custom-action/use-custom-action-execution"
import { ANALYTICS_SURFACE } from "@/types/analytics"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  PROVIDER_ID,
  providerRow,
  storeProvider,
} from "@/utils/content-script/__tests__/provider-snapshot-fixtures"
import { installProviderTransport } from "@/utils/content-script/__tests__/provider-transport"
import { installStreamPortBridge } from "@/utils/content-script/__tests__/stream-port-bridge"
import { getBuiltInDictionaryAction } from "@/utils/custom-actions"
import { resolveProviderRefForCapability } from "@/utils/providers/provider-registry"
import {
  installChrome,
  installFirefox,
  removePermissionsDouble,
  NOTHING_GRANTED,
  WITH_ALL,
  WITH_CREDENTIALS,
  WITH_PAGE_URL,
} from "./firefox-permissions"

const PAGE_URL = window.location.href
const TOKEN = "{{webUrl}}"

// "values" puts the page's own text into the request (selection, paragraphs, title, content) in
// the prompt, the system prompt and a field description, and never uses the URL token itself.
type Template = "prompt" | "systemPrompt" | "outputFieldDescription" | "none" | "values"

function actionUsing(template: Template) {
  const action = getBuiltInDictionaryAction(DEFAULT_CONFIG.selectionToolbar)
  return {
    ...action,
    id: "synthetic-custom-action",
    prompt:
      template === "prompt"
        ? `Explain {{selection}} (from ${TOKEN})`
        : template === "values"
          ? "Explain {{selection}} in {{paragraphs}} on {{webTitle}}: {{webContent}}"
          : "Explain {{selection}}",
    systemPrompt:
      template === "systemPrompt"
        ? `You read pages. Page: ${TOKEN}`
        : template === "values"
          ? "You read {{webTitle}} and explain {{selection}}."
          : "You explain words.",
    outputSchema: [
      {
        id: "f1",
        name: "result",
        type: "string" as const,
        description:
          template === "outputFieldDescription"
            ? `The meaning on ${TOKEN}`
            : template === "values"
              ? "The meaning of {{selection}} in {{paragraphs}}"
              : "",
      },
    ],
  }
}

/** The same provider with no key: its request carries no credential. */
const keylessRow = { ...providerRow("a"), apiKey: undefined } as LLMProviderConfig
const keyedRow = providerRow("a")

interface HookProps {
  executionContext: ReturnType<typeof buildCustomActionExecutionPlan>["executionContext"]
  open: boolean
}

interface PageInputs {
  selection?: string
  paragraphs?: string
  page?: CachedWebPageContext | null
}

function propsFor(row: LLMProviderConfig, template: Template, inputs: PageInputs = {}): HookProps {
  const provider = resolveProviderRefForCapability("customAction", [row], PROVIDER_ID)
  if (!provider) throw new Error("The test provider must resolve")
  const plan = buildCustomActionExecutionPlan(
    { language: DEFAULT_CONFIG.language, action: actionUsing(template), provider },
    inputs.selection ?? "selected words",
    inputs.paragraphs ?? "selected words in a sentence",
    inputs.page ?? null,
  )
  return { executionContext: plan.executionContext, open: true }
}

function mountRun(row: LLMProviderConfig, template: Template, inputs: PageInputs = {}) {
  return renderHook(
    (props: HookProps) =>
      useCustomActionExecution({
        analyticsSurface: ANALYTICS_SURFACE.SELECTION_TOOLBAR,
        bodyRef: { current: null },
        popoverSessionKey: 0,
        rerunNonce: 0,
        ...props,
      }),
    { initialProps: propsFor(row, template, inputs) },
  )
}

let bridge: ReturnType<typeof installStreamPortBridge>
let transport: ReturnType<typeof installProviderTransport>

beforeEach(() => {
  fakeBrowser.reset()
  bridge = installStreamPortBridge()
  transport = installProviderTransport(JSON.stringify({ result: "done" }))
})

afterEach(() => {
  cleanup()
  bridge.dispose()
  vi.unstubAllGlobals()
  removePermissionsDouble()
})

const sentUrl = () =>
  transport.requests.some((request) => JSON.stringify(request.body).includes(PAGE_URL))

describe("a run whose templates use {{webUrl}}, with browsingActivity not granted", () => {
  it.each<[string, Template]>([
    ["the prompt", "prompt"],
    ["the system prompt", "systemPrompt"],
    ["an output-field description", "outputFieldDescription"],
  ])("does not send the page URL when it is in %s", async (_name, template) => {
    installFirefox(NOTHING_GRANTED)
    await storeProvider(keylessRow)
    const { result } = mountRun(keylessRow, template)

    await waitFor(() => expect(result.current.isRunning).toBe(false))

    expect(sentUrl()).toBe(false)
    expect(transport.requests).toHaveLength(0)
    expect(result.current.error?.description).toMatch(/consent/i)
  })

  it("is checked on its own: a granted authenticationInfo does not admit the URL", async () => {
    installFirefox(WITH_CREDENTIALS)
    await storeProvider(keyedRow)
    const { result } = mountRun(keyedRow, "prompt")

    await waitFor(() => expect(result.current.isRunning).toBe(false))

    expect(transport.requests).toHaveLength(0)
    expect(result.current.error?.description).toMatch(/consent/i)
  })

  it("is checked on its own: a granted browsingActivity does not admit a credential", async () => {
    installFirefox(WITH_PAGE_URL)
    await storeProvider(keyedRow)
    const { result } = mountRun(keyedRow, "none")

    await waitFor(() => expect(result.current.isRunning).toBe(false))

    expect(transport.requests).toHaveLength(0)
    expect(result.current.error?.description).toMatch(/consent/i)
  })
})

describe("a run whose templates use {{webUrl}}, with browsingActivity granted", () => {
  it("sends the page URL, as before", async () => {
    installFirefox(WITH_PAGE_URL)
    await storeProvider(keylessRow)
    const { result } = mountRun(keylessRow, "prompt")

    await waitFor(() => expect(result.current.result).toEqual({ result: "done" }))

    expect(sentUrl()).toBe(true)
  })

  it("needs both grants when the provider also carries a key", async () => {
    installFirefox(WITH_ALL)
    await storeProvider(keyedRow)
    const { result } = mountRun(keyedRow, "prompt")

    await waitFor(() => expect(result.current.result).toEqual({ result: "done" }))

    expect(sentUrl()).toBe(true)
    expect(transport.requests[0]!.headers.authorization).toBe("Bearer key-a")
  })
})

describe("a run that sends no page URL", () => {
  it("needs neither optional category and does not ask the browser", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)
    await storeProvider(keylessRow)
    const { result } = mountRun(keylessRow, "none")

    await waitFor(() => expect(result.current.result).toEqual({ result: "done" }))

    expect(sentUrl()).toBe(false)
    expect(transport.requests).toHaveLength(1)
    expect(permissions.browserCalls()).toBe(0)
  })
})

describe("page text that looks like the URL token, in a run whose templates never use it", () => {
  const looksLikeToken = {
    selection: TOKEN,
    paragraphs: TOKEN,
    page: { webTitle: TOKEN, url: PAGE_URL, webContent: TOKEN } as CachedWebPageContext,
  }

  it("stays text: the page URL is not put into the request, and no consent is needed", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)
    await storeProvider(keylessRow)
    const { result } = mountRun(keylessRow, "values", looksLikeToken)

    await waitFor(() => expect(result.current.result).toEqual({ result: "done" }))

    expect(sentUrl()).toBe(false)
    expect(transport.requests).toHaveLength(1)
    expect(permissions.browserCalls()).toBe(0)
  })

  it.each<[string, PageInputs]>([
    ["the selection", { selection: TOKEN }],
    ["the surrounding paragraphs", { paragraphs: TOKEN }],
    ["the page title", { page: { webTitle: TOKEN, url: PAGE_URL, webContent: "" } }],
    ["the page content", { page: { webTitle: "A page", url: PAGE_URL, webContent: TOKEN } }],
  ])("in %s, it reaches the provider as the text it is", async (_name, inputs) => {
    installFirefox(NOTHING_GRANTED)
    await storeProvider(keylessRow)
    const { result } = mountRun(keylessRow, "values", inputs)

    await waitFor(() => expect(result.current.result).toEqual({ result: "done" }))

    expect(sentUrl()).toBe(false)
    expect(JSON.stringify(transport.requests[0]!.body)).toContain(TOKEN)
  })
})

describe("Chrome build", () => {
  it("sends the page URL and never asks the browser for consent", async () => {
    const permissions = installChrome()
    await storeProvider(keyedRow)
    const { result } = mountRun(keyedRow, "prompt")

    await waitFor(() => expect(result.current.result).toEqual({ result: "done" }))

    expect(sentUrl()).toBe(true)
    expect(permissions.browserCalls()).toBe(0)
  })
})
