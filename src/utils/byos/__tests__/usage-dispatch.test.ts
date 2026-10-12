import { describe, expect, it, vi } from "vitest"
import { RESOURCE, SCOPES, TOKEN_URL } from "../oidc"
import { createByosService } from "../service"
import { callbackUrl, credentials, fetchUrl, memoryVault, mockTransport } from "./auth-fixtures"

const completed = () =>
  new Response(
    'data: {"type":"response.output_text.delta","delta":"synthetic result"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    { headers: { "Content-Type": "text/event-stream" } },
  )
async function setup(fetcher: typeof fetch) {
  const vault = memoryVault()
  await vault.update((record) => {
    record.credentials = credentials()
  })
  return createByosService(vault, mockTransport(), "extension", callbackUrl, fetcher)
}

describe("BYOS inference dispatch observation", () => {
  it("observes the bounded inference resend but excludes refresh and model lists", async () => {
    let attempts = 0
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = fetchUrl(input)
      if (url === TOKEN_URL)
        return Response.json({
          access_token: "synthetic-new-access",
          refresh_token: "synthetic-new-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: SCOPES,
        })
      if (url === `${RESOURCE}/models`) return Response.json({ models: [] })
      attempts++
      return attempts === 1
        ? Response.json({ error: { code: "invalid_token" } }, { status: 401 })
        : completed()
    })
    const service = await setup(fetcher)
    const onDispatch = vi.fn<() => void>()
    expect(
      await service.invoke({ model: "synthetic-model", text: "source" }, undefined, onDispatch),
    ).toEqual({ text: "synthetic result" })
    await service.models()
    expect(onDispatch).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it("does not count a denied invocation or cancellation before transport", async () => {
    const fetcher = vi.fn<typeof fetch>()
    const onDispatch = vi.fn<() => void>()
    const service = createByosService(
      memoryVault(),
      mockTransport(),
      "extension",
      callbackUrl,
      fetcher,
    )
    await expect(
      service.invoke({ model: "synthetic-model", text: "source" }, undefined, onDispatch),
    ).rejects.toThrow("authorization_required")
    await expect(
      service.invoke({ model: "synthetic-model", text: "source" }, AbortSignal.abort(), onDispatch),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(onDispatch).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("observes a broken accepted stream once without changing its non-retryable failure", async () => {
    const service = await setup(
      async () =>
        new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        }),
    )
    const onDispatch = vi.fn<() => void>()
    await expect(
      service.invoke({ model: "synthetic-model", text: "source" }, undefined, onDispatch),
    ).rejects.toMatchObject({ isRetryable: false })
    expect(onDispatch).toHaveBeenCalledTimes(1)
  })

  it("keeps metering errors outside the BYOS request lifecycle", async () => {
    const service = await setup(async () => completed())
    await expect(
      service.invoke({ model: "synthetic-model", text: "source" }, undefined, () => {
        throw new Error("synthetic observer failure")
      }),
    ).resolves.toEqual({ text: "synthetic result" })
  })
})
