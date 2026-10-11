import type { Config } from "@/types/config/config"

export type ByosTarget = "page" | "selection" | "dictionary"

/** Save a discovered model and optionally assign it to a translation feature. */
export function buildByosProviderPatch(
  current: Config,
  model: string,
  target?: ByosTarget,
): Partial<Config> {
  const existing = current.providersConfig.find((p) => p.provider === "byos")
  const id = existing?.id || "lingotori-byos"
  const next = {
    id,
    name: "ChatGPT",
    enabled: true,
    provider: "byos" as const,
    model: {
      model: "use-custom-model" as const,
      isCustomModel: true as const,
      customModel: model,
    },
  }
  return {
    providersConfig: existing
      ? current.providersConfig.map((p) =>
          p.id === id && p.provider === "byos" ? { ...p, enabled: true, model: next.model } : p,
        )
      : [...current.providersConfig, next],
    ...(target === "page"
      ? { pageTranslation: { ...current.pageTranslation, providerId: id } }
      : {}),
    ...(target === "selection"
      ? {
          selectionToolbar: {
            ...current.selectionToolbar,
            features: {
              ...current.selectionToolbar.features,
              translate: { ...current.selectionToolbar.features.translate, providerId: id },
            },
          },
        }
      : {}),
    ...(target === "dictionary"
      ? {
          selectionToolbar: {
            ...current.selectionToolbar,
            builtInActions: {
              ...current.selectionToolbar.builtInActions,
              dictionary: {
                ...current.selectionToolbar.builtInActions.dictionary,
                providerId: id,
              },
              sentenceAnalysis: {
                ...current.selectionToolbar.builtInActions.sentenceAnalysis,
                providerId: id,
              },
            },
          },
        }
      : {}),
  }
}
