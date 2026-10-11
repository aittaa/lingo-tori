/** Independent LingoTori configuration. Frozen migration; no runtime imports. */
export function migrate(oldConfig: any): any {
  const next = structuredClone(oldConfig)
  delete next.tts
  delete next.inputTranslation
  delete next.analytics
  const retired = new Set([
    "google-translate",
    "microsoft-translate",
    "read-frog-free-ai",
    "read-frog-advance-ai",
    "system",
  ])
  next.providersConfig = (next.providersConfig ?? [])
    .filter((provider: any) => !retired.has(provider.provider) && !retired.has(provider.id))
    .map((provider: any) => {
      for (const key of ["tts", "speech", "audio", "speechModel", "ttsModel", "transcriptionModel"])
        delete provider[key]
      return provider
    })
  const enabledIds = new Set(
    next.providersConfig
      .filter((provider: any) => provider.enabled)
      .map((provider: any) => provider.id),
  )
  const normalize = (value: any) => (enabledIds.has(value) ? value : "unconfigured")
  for (const feature of [
    next.pageTranslation,
    next.videoSubtitles,
    next.selectionToolbar?.features?.translate,
    next.selectionToolbar?.noteSuggestion,
  ]) {
    if (feature) feature.providerId = normalize(feature.providerId)
  }
  if (next.languageDetection?.mode === "llm" && !enabledIds.has(next.languageDetection.providerId))
    next.languageDetection = { mode: "basic" }
  if (next.translationHub?.selectedProviderIds)
    next.translationHub.selectedProviderIds = next.translationHub.selectedProviderIds.filter(
      (id: string) => enabledIds.has(id),
    )
  const toolbar = next.selectionToolbar
  if (toolbar) {
    if (toolbar.features) delete toolbar.features.speak
    if (toolbar.builtInActions) {
      delete toolbar.builtInActions.improveWriting
      for (const action of Object.values<any>(toolbar.builtInActions)) {
        action.providerId = normalize(action.providerId)
        delete action.notebaseConnection
      }
    }
    toolbar.customActions = (toolbar.customActions ?? [])
      .filter((action: any) => action.id !== "default-improve-writing")
      .map((action: any) => {
        action.providerId = normalize(action.providerId)
        action.layout = ""
        delete action.notebaseConnection
        return action
      })
    if (
      toolbar.noteSuggestion &&
      ![
        "default-dictionary",
        "default-sentence-analysis",
        ...toolbar.customActions.map((action: any) => action.id),
      ].includes(toolbar.noteSuggestion.actionId)
    )
      toolbar.noteSuggestion.actionId = "default-dictionary"
    for (const key of ["order", "unpinned"])
      if (Array.isArray(toolbar[key]))
        toolbar[key] = toolbar[key].filter(
          (id: string) => id !== "speak" && id !== "default-improve-writing",
        )
  }
  if (!["auto", "en", "ko", "ja"].includes(next.uiLanguage)) next.uiLanguage = "auto"
  return next
}
