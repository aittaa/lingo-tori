import { expect, it, vi } from "vitest"
import { createByosService } from "../service"
import { callbackUrl, memoryVault, mockTransport } from "./auth-fixtures"

it("requires authenticated access for a saved model without starting sign-in or inference", async () => {
  const vault = memoryVault(),
    transport = mockTransport(),
    fetcher = vi.fn<typeof fetch>()
  const service = createByosService(vault, transport, "extension", callbackUrl, fetcher)
  await expect(
    service.invoke({ model: "saved-model", text: "Synthetic source" }),
  ).rejects.toMatchObject({ code: "plan_permission_required" })
  expect(fetcher).not.toHaveBeenCalled()
  expect(transport.createTab).not.toHaveBeenCalled()
  expect(transport.navigate).not.toHaveBeenCalled()
  expect(await service.session()).toMatchObject({ state: "disconnected", authPending: false })
})
