// @vitest-environment node
//
// A ChatGPT request made outside the background (the settings pages) reaches the background as an
// internal message. The optional categories the request sends travel with it, so the background can
// check them at the dispatch; a malformed list is refused rather than ignored.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { invokeByos } from "@/utils/byos/invoke"
import { dataCategoriesSchema } from "@/utils/firefox-data-consent"

const { sendByosMessage } = vi.hoisted(() => ({
  sendByosMessage: vi.fn<(name: string, data: unknown) => Promise<unknown>>(),
}))

vi.mock("@/utils/byos/messages", () => ({ sendByosMessage }))

beforeEach(() => {
  sendByosMessage.mockReset()
  sendByosMessage.mockResolvedValue({ text: "done" })
})

const payload = { model: "synthetic-model", text: "Hello" }

describe("invokeByos from a page other than the background", () => {
  it("sends the declared categories with the invocation", async () => {
    await invokeByos(payload, undefined, "customAction", { dataCategories: ["browsingActivity"] })

    expect(sendByosMessage).toHaveBeenCalledWith(
      "lingotoriByosInvoke",
      expect.objectContaining({
        payload,
        usageFeature: "customAction",
        dataCategories: ["browsingActivity"],
      }),
    )
  })

  it("sends none when the request declares none", async () => {
    await invokeByos(payload, undefined, "customAction")

    expect(sendByosMessage.mock.calls[0]![1]).toMatchObject({ dataCategories: undefined })
  })
})

describe("the declared categories on the wire", () => {
  it.each([[undefined], [[]], [["browsingActivity"]]])("accepts %j", (value) => {
    expect(dataCategoriesSchema.safeParse(value).success).toBe(true)
  })

  it.each([
    [["authenticationInfo"]],
    [["nothing"]],
    [[1]],
    ["browsingActivity"],
    [Array.from({ length: 5 }, () => "browsingActivity")],
  ])("refuses %j", (value) => {
    expect(dataCategoriesSchema.safeParse(value).success).toBe(false)
  })
})
