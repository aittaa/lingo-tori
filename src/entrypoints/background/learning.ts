import { browser } from "wxt/browser"
import { onLearningMessage } from "@/utils/learning/messages"
import { createLearningPersistence } from "@/utils/learning/persistence"
import { createLearningService } from "@/utils/learning/service"

export function assertLearningSender(
  sender: { id?: string; url?: string },
  extensionId: string,
  studyUrl?: string,
) {
  if (sender.id !== extensionId) throw new Error("Untrusted learning sender")
  if (studyUrl && sender.url !== studyUrl)
    throw new Error("Open the extension study page to perform this action")
}
export function setupLearning() {
  const service = createLearningService(createLearningPersistence())
  const trusted = (sender: { id?: string; url?: string }) =>
    assertLearningSender(sender, browser.runtime.id)
  const privatePage = (sender: { id?: string; url?: string }) =>
    assertLearningSender(sender, browser.runtime.id, browser.runtime.getURL("/study.html"))
  onLearningMessage("lingotoriSave", ({ data, sender }) => {
    trusted(sender)
    return service.save(data)
  })
  onLearningMessage("lingotoriCounts", ({ sender }) => {
    trusted(sender)
    return service.counts()
  })
  onLearningMessage("lingotoriOpenStudy", async ({ sender }) => {
    trusted(sender)
    await browser.tabs.create({ url: browser.runtime.getURL("/study.html") })
  })
  onLearningMessage("lingotoriState", ({ sender }) => {
    privatePage(sender)
    return service.read()
  })
  onLearningMessage("lingotoriReview", ({ sender, data }) => {
    privatePage(sender)
    return service.review(data)
  })
  onLearningMessage("lingotoriImport", ({ sender, data }) => {
    privatePage(sender)
    return service.import(data)
  })
  onLearningMessage("lingotoriSyncStatus", ({ sender }) => {
    privatePage(sender)
    return service.configStatus()
  })
  onLearningMessage("lingotoriConfigureSync", ({ sender, data }) => {
    privatePage(sender)
    return service.configure(data)
  })
  onLearningMessage("lingotoriSync", ({ sender }) => {
    privatePage(sender)
    return service.sync()
  })
}
