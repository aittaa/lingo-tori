import type { Config } from "@/types/config/config"
import { mergeWithArrayOverwrite } from "@/utils/atoms/config"
import { buildFirstProviderDefaultsPatch } from "@/utils/config/first-provider-defaults"

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
  const defaults = model ? buildFirstProviderDefaultsPatch(current, next) : {}
  const assigned = mergeWithArrayOverwrite(current, defaults)
  return {
    ...defaults,
    providersConfig: existing
      ? current.providersConfig.map((p) =>
          p.id === id && p.provider === "byos" ? { ...p, enabled: true, model: next.model } : p,
        )
      : [...current.providersConfig, next],
    ...(target === "page"
      ? { pageTranslation: { ...assigned.pageTranslation, providerId: id } }
      : {}),
    ...(target === "selection"
      ? {
          selectionToolbar: {
            ...assigned.selectionToolbar,
            features: {
              ...assigned.selectionToolbar.features,
              translate: { ...assigned.selectionToolbar.features.translate, providerId: id },
            },
          },
        }
      : {}),
    ...(target === "dictionary"
      ? {
          selectionToolbar: {
            ...assigned.selectionToolbar,
            builtInActions: {
              ...assigned.selectionToolbar.builtInActions,
              dictionary: {
                ...assigned.selectionToolbar.builtInActions.dictionary,
                providerId: id,
              },
              sentenceAnalysis: {
                ...assigned.selectionToolbar.builtInActions.sentenceAnalysis,
                providerId: id,
              },
            },
          },
        }
      : {}),
  }
}
