import type { LLMProviderConfig } from "@/types/config/provider"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  generateTextForProviderRef,
  runStreamTextInBackground,
} from "@/entrypoints/background/background-stream"
import { createApiUsageHistoryRecorder, historyFeatureTotals } from "@/utils/api-usage-history"
import { createApiUsageIdentity } from "@/utils/api-usage-identity"
import {
  installApiUsageObserver,
  installApiUsageResultObserver,
  recordApiUsageAttempt,
} from "@/utils/api-usage-tracking"
import { installByosBackgroundInvoker } from "../invoke"
import { SCOPES, TOKEN_URL } from "../oidc"
import { createByosService } from "../service"
import { callbackUrl, credentials, fetchUrl, memoryVault, mockTransport } from "./auth-fixtures"

const config: LLMProviderConfig = {
  id: "synthetic-byos",
  name: "private label",
  provider: "byos",
  enabled: true,
  model: { model: "use-custom-model", isCustomModel: true, customModel: "gpt-6.1-sol" },
}
const identity = createApiUsageIdentity(config)
afterEach(() => {
  installApiUsageObserver(() => {})
  installApiUsageResultObserver(undefined)
  installByosBackgroundInvoker(async () => {
    throw new Error("Synthetic invoker not installed")
  })
})
async function setup(withUsage: boolean, resend = false, truncated = false) {
  let saved: unknown = null
  const history = createApiUsageHistoryRecorder({
    read: async () => structuredClone(saved),
    write: async (value) => {
      saved = structuredClone(value)
    },
  })
  installApiUsageObserver((feature, _transport, model) => {
    if (model) history.attempt(feature, model)
  })
  installApiUsageResultObserver((feature, model, tokens) => history.result(feature, model, tokens))
  let attempts = 0
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (fetchUrl(input) === TOKEN_URL)
      return Response.json({
        access_token: "synthetic-access-2",
        refresh_token: "synthetic-refresh-2",
        token_type: "Bearer",
        expires_in: 3600,
        scope: SCOPES,
      })
    attempts++
    if (resend && attempts === 1)
      return Response.json({ error: { code: "invalid_token" } }, { status: 401 })
    const completed = {
      type: "response.completed",
      response: {
        status: "completed",
        ...(withUsage
          ? {
              usage: {
                input_tokens: 100,
                output_tokens: 20,
                input_tokens_details: { cached_tokens: 60 },
              },
            }
          : {}),
      },
    }
    return new Response(
      `data: {"type":"response.output_text.delta","delta":"translated"}\n\ndata: ${JSON.stringify(completed)}${truncated ? "" : "\n\n"}`,
      { headers: { "Content-Type": "text/event-stream" } },
    )
  })
  const vault = memoryVault()
  await vault.update((value) => {
    value.credentials = credentials()
  })
  const service = createByosService(vault, mockTransport(), "extension", callbackUrl, fetcher)
  installByosBackgroundInvoker((payload, signal, feature) =>
    service.invoke(payload, signal, () => {
      if (feature) recordApiUsageAttempt(feature, "byos", identity)
    }),
  )
  const totals = async () =>
    historyFeatureTotals((await history.snapshot()).history!, "0000-01-01", "9999-12-31", [
      identity.id,
    ])
  return { totals, fetcher, saved: () => saved }
}

describe("retained BYOS generation usage recording", () => {
  it("records one measured result across a bounded resend while excluding refresh from requests", async () => {
    const fixture = await setup(true, true)
    expect(
      await generateTextForProviderRef(
        {
          providerRef: { kind: "local", config },
          instructions: "Translate",
          prompt: "private source",
        },
        { usageFeature: "pageTranslation" },
      ),
    ).toBe("translated")
    expect((await fixture.totals()).pageTranslation).toMatchObject({
      requests: 2,
      results: 1,
      inputReports: 1,
      outputReports: 1,
      inputTokens: 100,
      outputTokens: 20,
    })
    expect(fixture.fetcher).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(fixture.saved())).not.toMatch(
      /private source|translated|synthetic-access|synthetic-refresh|private label/,
    )
  })

  it.each([true, false])(
    "keeps the original stream while recording available usage only (%s)",
    async (available) => {
      const fixture = await setup(available)
      expect(
        (
          await runStreamTextInBackground({
            providerKind: "local",
            providerId: config.id,
            providerConfig: config,
            usageFeature: "videoSummary",
            instructions: "Summarize",
            prompt: "private source",
          })
        ).output,
      ).toBe("translated")
      expect((await fixture.totals()).videoSummary).toMatchObject({
        requests: 1,
        results: 1,
        inputReports: available ? 1 : 0,
        outputReports: available ? 1 : 0,
        inputTokens: available ? 100 : 0,
        outputTokens: available ? 20 : 0,
      })
      expect(fixture.fetcher).toHaveBeenCalledTimes(1)
    },
  )

  it("keeps a truncated stream failed and its token coverage unknown without retrying", async () => {
    const fixture = await setup(true, false, true)
    await expect(
      runStreamTextInBackground({
        providerKind: "local",
        providerId: config.id,
        providerConfig: config,
        usageFeature: "videoSummary",
        instructions: "Summarize",
        prompt: "private source",
      }),
    ).rejects.toMatchObject({ isRetryable: false })
    expect((await fixture.totals()).videoSummary).toMatchObject({
      requests: 1,
      results: 1,
      inputReports: 0,
      outputReports: 0,
    })
    expect(fixture.fetcher).toHaveBeenCalledTimes(1)
  })
})
