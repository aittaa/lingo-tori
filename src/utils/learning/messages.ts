import type { LearningState, ReviewEvent } from "./core"
import type { NoteInput, SyncConfig } from "./service"
import { defineExtensionMessaging } from "@webext-core/messaging"
interface LearningProtocol {
  lingotoriSave: (notes: NoteInput[]) => { saved: number }
  lingotoriCounts: () => { notes: number; due: number }
  lingotoriOpenStudy: () => void
  lingotoriState: () => LearningState
  lingotoriReview: (event: ReviewEvent) => LearningState
  lingotoriImport: (state: unknown) => LearningState
  lingotoriSyncStatus: () => { url: string; configured: boolean }
  lingotoriConfigureSync: (config: SyncConfig | null) => void
  lingotoriSync: () => LearningState
}
export const { sendMessage: sendLearningMessage, onMessage: onLearningMessage } =
  defineExtensionMessaging<LearningProtocol>()
