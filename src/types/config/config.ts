import { z } from "zod"
import { langCodeISO6393Schema, langLevel } from "@/lib/languages"
import {
  BUILT_IN_ACTION_IDS,
  BUILT_IN_ACTION_KEYS,
  isBuiltInActionId,
} from "@/utils/constants/custom-action"
import { FEATURE_KEYS, FEATURE_PROVIDER_DEFS } from "@/utils/constants/feature-providers"
import { DEFAULT_TRANSLATION_HUB_SHORTCUT_KEY } from "@/utils/constants/legacy-config"
import {
  MAX_SELECTION_OVERLAY_OPACITY,
  MIN_SELECTION_OVERLAY_OPACITY,
} from "@/utils/constants/selection"
import { MIN_SIDE_CONTENT_WIDTH } from "@/utils/constants/side"
import { SUPPORTED_UI_LOCALES } from "@/utils/i18n/locales"
import {
  doesProviderSupportsCapability,
  getProviderIdsForCapability,
} from "@/utils/providers/provider-registry"
import { normalizeSelectionToolbarLists } from "@/utils/selection-toolbar-order"
import { floatingButtonSchema } from "./floating-button"
import { glossaryConfigSchema } from "./glossary"
import { languageDetectionConfigSchema } from "./language-detection"
import { providersConfigSchema } from "./provider"
import {
  selectionToolbarBuiltInActionsSchema,
  selectionToolbarCustomActionsSchema,
} from "./selection-toolbar"
import { shortcutSchema } from "./shortcut"
import { siteRulesConfigSchema } from "./site-rules"
import { videoSubtitlesSchema } from "./subtitles"
import { translateConfigSchema } from "./translate"
// Language schema
const languageSchema = z.object({
  sourceCode: langCodeISO6393Schema.or(z.literal("auto")),
  targetCode: langCodeISO6393Schema,
  level: langLevel,
})

const selectionToolbarFeatureSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().nonempty(),
  shortcut: shortcutSchema,
})

// Text selection toolbar schema
const selectionToolbarSchema = z
  .object({
    enabled: z.boolean(),
    disabledSelectionToolbarPatterns: z.array(z.string()),
    opacity: z.number().min(MIN_SELECTION_OVERLAY_OPACITY).max(MAX_SELECTION_OVERLAY_OPACITY),
    features: z.object({
      translate: selectionToolbarFeatureSchema,
    }),
    builtInActions: selectionToolbarBuiltInActionsSchema,
    customActions: selectionToolbarCustomActionsSchema,
    // The order of every toolbar item (translate, speak and the actions), by
    // id. Kept in step with the items by the transform below. `.default([])`
    // lets a config stored before this field parse in UI contexts that load
    // ahead of the background migration.
    order: z.array(z.string().min(1)).default([]),
    // Ids of the items kept off the toolbar itself, in its "more" menu only.
    // Every other item is pinned. Independent of an item's enabled switch,
    // so a pin survives the item being turned off and on.
    unpinned: z.array(z.string().min(1)).default([]),
    noteSuggestion: z.object({
      enabled: z.boolean(),
      actionId: z.string().nonempty(),
      providerId: z.string().nonempty(),
    }),
  })
  .superRefine((selectionToolbar, ctx) => {
    const actionId = selectionToolbar.noteSuggestion.actionId
    const actionExists =
      isBuiltInActionId(actionId) ||
      selectionToolbar.customActions.some((action) => action.id === actionId)

    if (!actionExists) {
      ctx.addIssue({
        code: "custom",
        message: `Note suggestion action "${actionId}" not found.`,
        path: ["noteSuggestion", "actionId"],
      })
    }
  })
  // Every parse brings `order` and `unpinned` in step with the actions there
  // are, so adding or deleting an action never has to update them itself.
  .transform((selectionToolbar) => normalizeSelectionToolbarLists(selectionToolbar))

// side content schema
const sideContentSchema = z.object({
  width: z.number().min(MIN_SIDE_CONTENT_WIDTH),
})

// Inert legacy Hub preferences: keep these fields when config is read, saved or exported.
// Removing the schema would strip saved values from every later config write.
// `.default()` mirrors `uiLanguageSchema`: it lets a
// config stored before this field existed still parse in UI contexts that load
// ahead of the background migration, instead of falling back to DEFAULT_CONFIG
// and writing that over the user's settings.
const translationHubSchema = z
  .object({
    shortcut: shortcutSchema,
    selectedProviderIds: z.array(z.string().min(1)).nullable().default(null),
    sourceCode: langCodeISO6393Schema.or(z.literal("auto")).nullable().default(null),
    targetCode: langCodeISO6393Schema.nullable().default(null),
    // A missing ID in a pre-migration config must stay unset until v102 copies
    // the page prompt; another UI context may write this config first.
    promptId: z.string().min(1).nullable().default(null),
  })
  .default({
    shortcut: DEFAULT_TRANSLATION_HUB_SHORTCUT_KEY,
    selectedProviderIds: null,
    sourceCode: null,
    targetCode: null,
    promptId: null,
  })

// beta experience schema
const betaExperienceSchema = z.object({
  enabled: z.boolean(),
})

// context menu schema
const contextMenuSchema = z.object({
  enabled: z.boolean(),
})

// site control schema
const siteControlSchema = z.object({
  mode: z.enum(["blacklist", "whitelist"]),
  blacklistPatterns: z.array(z.string()),
  whitelistPatterns: z.array(z.string()),
})

// Interface language for the extension UI, independent of the browser language.
// "auto" follows the browser UI language; explicit values are the supported locales.
// Share the runtime locale list without importing the translation resources.
// `.default("auto")` is load-bearing: it lets configs stored before this field existed still
// parse successfully, avoiding the destructive fallback-to-DEFAULT_CONFIG path in
// `writeConfigAtom` / `initializeConfig` during the upgrade window.
const uiLanguageSchema = z.enum(["auto", ...SUPPORTED_UI_LOCALES]).default("auto")
export type UiLanguage = z.infer<typeof uiLanguageSchema>

// Complete config schema
export const configSchema = z
  .object({
    language: languageSchema,
    providersConfig: providersConfigSchema,
    pageTranslation: translateConfigSchema,
    languageDetection: languageDetectionConfigSchema,
    floatingButton: floatingButtonSchema,
    selectionToolbar: selectionToolbarSchema,
    sideContent: sideContentSchema,
    betaExperience: betaExperienceSchema,
    contextMenu: contextMenuSchema,
    videoSubtitles: videoSubtitlesSchema,
    siteControl: siteControlSchema,
    siteRules: siteRulesConfigSchema,
    uiLanguage: uiLanguageSchema,
    translationHub: translationHubSchema,
    glossary: glossaryConfigSchema,
  })
  .superRefine((data, ctx) => {
    // Preserve saved BYOS assignments, including OFF rows, without resetting
    // unrelated BYOK settings. Execution still checks enablement and authentication.
    const isStoredByosAssignment = (providerId: string) =>
      data.providersConfig.some(
        (provider) => provider.id === providerId && provider.provider === "byos",
      )
    for (const featureKey of FEATURE_KEYS) {
      const def = FEATURE_PROVIDER_DEFS[featureKey]
      const providerId = def.getProviderId(data)

      if (
        providerId !== "unconfigured" &&
        !isStoredByosAssignment(providerId) &&
        !doesProviderSupportsCapability(featureKey, data.providersConfig, providerId, {
          requireEnable: true,
        })
      ) {
        ctx.addIssue({
          code: "invalid_value",
          values: getProviderIdsForCapability(featureKey, data.providersConfig, {
            requireEnable: true,
          }),
          message: `Invalid provider id "${providerId}".`,
          path: [...def.configPath],
        })
        continue
      }
    }

    // Validate languageDetection: when mode is "llm", providerId must be a valid enabled LLM provider
    if (data.languageDetection.mode === "llm") {
      const ldProviderId = data.languageDetection.providerId
      if (!ldProviderId) {
        ctx.addIssue({
          code: "custom",
          message: `Language detection mode is "llm" but no providerId is configured.`,
          path: ["languageDetection", "providerId"],
        })
      } else if (
        // Capability-based, like the FEATURE_KEYS loop above, rather than a
        // providersConfig lookup: Built-in AI is never a row in
        // providersConfig, so requiring one there is what used to make a
        // hosted provider fail validation and reset the whole config.
        !isStoredByosAssignment(ldProviderId) &&
        !doesProviderSupportsCapability("languageDetection", data.providersConfig, ldProviderId, {
          requireEnable: true,
        })
      ) {
        ctx.addIssue({
          code: "invalid_value",
          values: getProviderIdsForCapability("languageDetection", data.providersConfig, {
            requireEnable: true,
          }),
          message: `Invalid provider id "${ldProviderId}".`,
          path: ["languageDetection", "providerId"],
        })
      }
    }

    const actionProviderEntries = [
      ...BUILT_IN_ACTION_IDS.map((id) => {
        const key = BUILT_IN_ACTION_KEYS[id]
        return {
          providerId: data.selectionToolbar.builtInActions[key].providerId,
          path: ["selectionToolbar", "builtInActions", key, "providerId"] as const,
        }
      }),
      ...data.selectionToolbar.customActions.map((action, index) => ({
        providerId: action.providerId,
        path: ["selectionToolbar", "customActions", index, "providerId"] as const,
      })),
    ]

    actionProviderEntries.forEach(({ providerId, path }) => {
      if (
        providerId !== "unconfigured" &&
        !isStoredByosAssignment(providerId) &&
        !doesProviderSupportsCapability("customAction", data.providersConfig, providerId, {
          requireEnable: true,
        })
      ) {
        ctx.addIssue({
          code: "invalid_value",
          values: getProviderIdsForCapability("customAction", data.providersConfig, {
            requireEnable: true,
          }),
          message: `Invalid provider id "${providerId}".`,
          path: [...path],
        })
      }
    })
  })

export type Config = z.infer<typeof configSchema>
