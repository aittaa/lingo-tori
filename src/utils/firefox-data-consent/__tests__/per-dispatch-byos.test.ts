// The ChatGPT (BYOS) path of "check the category at each dispatch". A custom action that uses
// {{webUrl}} can run on the ChatGPT provider; its request carries the page URL to OpenAI. The grant
// for browsingActivity must hold when that request is actually sent, not only when the stream was
// admitted, and the sign-in's own credential check (authenticationInfo) does not stand in for it.
//
// Real: the stream client, the background dispatcher, the model factory, the BYOS model, the
// background invoker installed by `setupByos`, the BYOS service and its invocation schema. Doubled:
// the port transport, the credential vault (in memory), the browser-tab transport and the network.
//
// These tests do not import the consent module: on the base commit the request is sent.

import type { LLMProviderConfig } from "@/types/config/provider"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { storage } from "#imports"
import { credentials, fetchUrl, memoryVault } from "@/utils/byos/__tests__/auth-fixtures"
import { RESOURCE } from "@/utils/byos/oidc"
import { CONFIG_STORAGE_KEY } from "@/utils/constants/config"
import {
  configWith,
  PROVIDER_ID,
} from "@/utils/content-script/__tests__/provider-snapshot-fixtures"
import { installStreamPortBridge } from "@/utils/content-script/__tests__/stream-port-bridge"
import { streamBackgroundText } from "@/utils/content-script/background-stream-client"
import { StreamPortError } from "@/utils/content-script/port-streaming"
import { buildLocalGenerateTextParams } from "@/utils/providers/generate-params"
import { setupByos } from "../../../entrypoints/background/byos"
import {
  installChrome,
  installFirefox,
  removePermissionsDouble,
  WITH_ALL,
  WITH_CREDENTIALS,
} from "./firefox-permissions"

// `setupByos` builds its service from these two factories, once, and the service keeps whatever
// `fetch` it is given. The vault and the network are therefore swappable holders.
const holders = vi.hoisted(() => ({
  vault: undefined as undefined | import("@/utils/byos/vault").AuthVault,
  upstream: undefined as
    | undefined
    | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>),
}))

vi.mock("@/utils/byos/vault", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/byos/vault")>()),
  createAuthVault: () => ({
    read: () => holders.vault!.read(),
    update: (change: never) => holders.vault!.update(change),
  }),
}))
vi.mock("@/utils/byos/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/byos/transport")>()),
  createAuthTransport: () => ({
    available: async () => true,
    createTab: async () => 42,
    install: async () => {},
    navigate: async () => {},
    cleanup: async () => {},
    reconcile: async (pending: unknown) => !!pending,
  }),
}))

const MODEL = "synthetic-model"
const byosRow: LLMProviderConfig = {
  id: PROVIDER_ID,
  name: "ChatGPT",
  provider: "byos",
  enabled: true,
  model: { model: "use-custom-model", isCustomModel: true, customModel: MODEL },
}

let bridge: ReturnType<typeof installStreamPortBridge>
const responses: Array<{ url: string; body: string }> = []

beforeAll(() => {
  // Registered once per JS context, with a network that forwards to the current test's handler.
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    holders.upstream!(input, init),
  )
  setupByos()
})

beforeEach(async () => {
  fakeBrowser.reset()
  bridge = installStreamPortBridge()
  responses.length = 0
  const vault = memoryVault()
  await vault.update((record) => {
    record.credentials = credentials()
    record.registration = {
      clientId: "synthetic-client",
      subject: "synthetic-subject",
      email: "person@example.test",
    }
  })
  holders.vault = vault
  holders.upstream = async (input, init) => {
    const url = fetchUrl(input)
    if (url !== `${RESOURCE}/responses`) throw new Error(`Unmocked upstream ${url}`)
    responses.push({ url, body: typeof init?.body === "string" ? init.body : "" })
    return new Response(
      'data: {"type":"response.output_text.delta","delta":"done"}\n\n' +
        'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    )
  }
  await storage.setItem(`local:${CONFIG_STORAGE_KEY}`, configWith(byosRow))
})

afterEach(() => {
  bridge.dispose()
  removePermissionsDouble()
})

const urlStream = () =>
  streamBackgroundText({
    usageFeature: "customAction",
    providerKind: "local",
    providerId: PROVIDER_ID,
    providerConfig: byosRow,
    instructions: "Explain",
    prompt: "Explain this page: https://page.example.test/",
    dataCategories: ["browsingActivity"],
    ...buildLocalGenerateTextParams(byosRow),
  })

describe("a ChatGPT request that sends the page URL", () => {
  it("is not sent when browsingActivity was withdrawn after the stream was admitted", async () => {
    const permissions = installFirefox(WITH_CREDENTIALS)
    permissions.getAll.mockImplementationOnce(async () => ({
      permissions: [],
      origins: [],
      data_collection: [...WITH_ALL],
    }))

    const error = await urlStream().catch((caught: unknown) => caught)

    expect(responses).toHaveLength(0)
    expect(error).toBeInstanceOf(StreamPortError)
    expect((error as Error).message).toMatch(/consent/i)
  })

  it("is sent while both grants hold, without the declared categories in its body", async () => {
    installFirefox(WITH_ALL)

    await expect(urlStream()).resolves.toMatchObject({ output: "done" })

    expect(responses).toHaveLength(1)
    expect(responses[0]!.body).not.toContain("dataCategories")
    expect(responses[0]!.body).not.toContain("browsingActivity")
  })

  it("is not sent without authenticationInfo either, as before", async () => {
    installFirefox(["browsingActivity"])

    await expect(urlStream()).rejects.toBeInstanceOf(StreamPortError)

    expect(responses).toHaveLength(0)
  })

  it("is sent on a Chrome build without asking the browser", async () => {
    const permissions = installChrome()

    await expect(urlStream()).resolves.toMatchObject({ output: "done" })

    expect(responses).toHaveLength(1)
    expect(permissions.browserCalls()).toBe(0)
  })
})
