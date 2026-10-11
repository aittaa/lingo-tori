import type { ByosInvocation, ByosModels, ByosSession } from "./service"
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
  lingotoriByosInvoke: (request: { requestId: string; payload: ByosInvocation }) => { text: string }
}
export const { sendMessage: sendByosMessage, onMessage: onByosMessage } =
  defineExtensionMessaging<ByosProtocol>()
