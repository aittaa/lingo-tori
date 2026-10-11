import type { BridgeConfig, ByosInvocation, ByosModels, ByosSession } from "./service"
import { defineExtensionMessaging } from "@webext-core/messaging"
interface ByosProtocol {
  lingotoriByosStatus: () => { configured: boolean; endpoint: string }
  lingotoriByosConfigure: (config: BridgeConfig | null) => void
  lingotoriByosSession: () => ByosSession
  lingotoriByosModels: () => ByosModels
  lingotoriByosAuth: () => void
  lingotoriByosSignout: () => ByosSession & { remoteRevocationConfirmed: boolean }
  lingotoriByosCancel: (requestId: string) => void
  lingotoriByosInvoke: (request: { requestId: string; payload: ByosInvocation }) => { text: string }
}
export const { sendMessage: sendByosMessage, onMessage: onByosMessage } =
  defineExtensionMessaging<ByosProtocol>()
