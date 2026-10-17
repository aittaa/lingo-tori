import type { ByosInvocation, ByosInvocationResult, ByosModels, ByosSession } from "./service"
import type { ApiUsageFeature } from "@/utils/api-usage"
import type { DataConsentCategory } from "@/utils/firefox-data-consent"
import { defineExtensionMessaging } from "@webext-core/messaging"
interface ByosProtocol {
  lingotoriByosStatus: () => { available: boolean; reason: string }
  lingotoriByosSession: () => ByosSession
  lingotoriByosModels: () => ByosModels
  lingotoriByosAuth: (attemptId: string) => void
  lingotoriByosCallback: (query: string) => ByosSession
  lingotoriByosCancelAuth: (attemptId: string) => void
  lingotoriByosSignout: () => ByosSession & { remoteRevocationConfirmed: boolean }
  lingotoriByosCancel: (requestId: string) => void
  lingotoriByosInvoke: (request: {
    requestId: string
    payload: ByosInvocation
    usageFeature?: ApiUsageFeature
    /** Internal: the optional categories the request sends, checked again at each dispatch. */
    dataCategories?: DataConsentCategory[]
  }) => ByosInvocationResult
}
export const { sendMessage: sendByosMessage, onMessage: onByosMessage } =
  defineExtensionMessaging<ByosProtocol>()
