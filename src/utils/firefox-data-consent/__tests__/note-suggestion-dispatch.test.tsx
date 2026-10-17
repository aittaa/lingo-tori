// @vitest-environment jsdom
//
// The note suggestion is built from a custom action's templates. When the action uses `{{webUrl}}`,
// the full page URL goes to the provider, which is `browsingActivity` for Firefox's data consent. On
// a Firefox build such a request starts only while `browsingActivity` is granted. The suggestion
// has no error UI by design (a failed request is silent and the card simply does not appear), so the
// proof is what reaches the provider.
//
// Real: the hook, the prompt builder, the content-side stream client, the background dispatcher and
// the note-suggestion stream handler, the model factory, the AI SDK. Doubled: the config atom, the
// port transport and the provider's network edge (shared helpers).

import type { LLMProviderConfig } from "@/types/config/provider"
import { act, cleanup, renderHook } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { useNoteSuggestion } from "@/entrypoints/selection.content/selection-toolbar/note-suggestion/use-note-suggestion"
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
  NOTHING_GRANTED,
  removePermissionsDouble,
  WITH_PAGE_URL,
} from "./firefox-permissions"

vi.mock("@/utils/atoms/config", async () => {
  const { atom } = await import("jotai")
  const { selectAtom } = await import("jotai/utils")
  const { DEFAULT_CONFIG: defaults } = await import("@/utils/constants/config")
  const config = atom(defaults)
  return {
    configAtom: config,
    configFieldsAtomMap: {
      selectionToolbar: selectAtom(config, (value) => value.selectionToolbar),
    },
    writeConfigAtom: atom(null, () => {}),
  }
})

const PAGE_URL = window.location.href
const ACTION_ID = "note-action-with-url"

/** The same provider with no key: its request carries no credential. */
const keylessRow = { ...providerRow("a"), apiKey: undefined } as LLMProviderConfig

function configUsing(template: "url" | "no-url") {
  const dictionary = getBuiltInDictionaryAction(DEFAULT_CONFIG.selectionToolbar)
  const action = {
    ...dictionary,
    id: ACTION_ID,
    prompt: template === "url" ? `Define {{selection}} (page: {{webUrl}})` : "Define {{selection}}",
  }
  return {
    ...structuredClone(DEFAULT_CONFIG),
    providersConfig: [keylessRow],
    selectionToolbar: {
      ...DEFAULT_CONFIG.selectionToolbar,
      customActions: [action],
      noteSuggestion: {
        ...DEFAULT_CONFIG.selectionToolbar.noteSuggestion,
        enabled: true,
        actionId: ACTION_ID,
        providerId: PROVIDER_ID,
      },
    },
  }
}

let bridge: ReturnType<typeof installStreamPortBridge>
let transport: ReturnType<typeof installProviderTransport>

beforeEach(async () => {
  fakeBrowser.reset()
  bridge = installStreamPortBridge()
  transport = installProviderTransport(JSON.stringify({ notes: [] }))
  await storeProvider(keylessRow)
})

afterEach(() => {
  cleanup()
  bridge.dispose()
  vi.unstubAllGlobals()
  removePermissionsDouble()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 60))
const sentUrl = () =>
  transport.requests.some((request) => JSON.stringify(request.body).includes(PAGE_URL))

async function run(template: "url" | "no-url", pageText?: string) {
  const store = createStore()
  const { configAtom } = await import("@/utils/atoms/config")
  store.set(configAtom, configUsing(template))
  const { result } = renderHook(() => useNoteSuggestion(), {
    wrapper: ({ children }) => createElement(Provider, { store }, children),
  })
  const provider = resolveProviderRefForCapability("noteSuggestion", [keylessRow], PROVIDER_ID)
  if (!provider) throw new Error("The test provider must resolve")
  await act(async () => {
    result.current.maybeFire({
      sessionKey: `session-${template}`,
      selectionText: pageText ?? "selected words",
      paragraphsText: pageText ?? "selected words in a sentence",
      targetLangName: "Korean",
      webTitle: pageText ?? "A page",
      provider,
    })
  })
  await settle()
}

describe("a note suggestion whose action uses {{webUrl}}", () => {
  it("does not send the page URL while browsingActivity is not granted", async () => {
    installFirefox(NOTHING_GRANTED)

    await run("url")

    expect(sentUrl()).toBe(false)
    expect(transport.requests).toHaveLength(0)
  })

  it("sends it once browsingActivity is granted", async () => {
    installFirefox(WITH_PAGE_URL)

    await run("url")

    expect(sentUrl()).toBe(true)
  })

  it("sends it on a Chrome build, which never asks the browser", async () => {
    const permissions = installChrome()

    await run("url")

    expect(sentUrl()).toBe(true)
    expect(permissions.browserCalls()).toBe(0)
  })
})

describe("page text that looks like the URL token, in a note suggestion whose action sends no URL", () => {
  it("stays text: the page URL is not put into the request, and no consent is needed", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)

    await run("no-url", "{{webUrl}}")

    expect(transport.requests).toHaveLength(1)
    expect(sentUrl()).toBe(false)
    expect(JSON.stringify(transport.requests[0]!.body)).toContain("{{webUrl}}")
    expect(permissions.browserCalls()).toBe(0)
  })
})

describe("a note suggestion whose action sends no page URL", () => {
  it("needs neither optional category", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)

    await run("no-url")

    expect(transport.requests).toHaveLength(1)
    expect(sentUrl()).toBe(false)
    expect(permissions.browserCalls()).toBe(0)
  })
})
