import { z } from "zod"
import { langCodeISO6393Schema } from "@/lib/languages"
import { isBuiltInActionId } from "@/utils/constants/custom-action"
import { shortcutSchema } from "./shortcut"

// Compatibility bound (UTF-16 code units) for inert legacy layouts. NEVER lower
// it: an older build that reads a config holding a longer layout fails schema
// validation, falls back to DEFAULT_CONFIG and overwrites the synced remote
// copy. Raising it is fine only together with a CONFIG_SCHEMA_VERSION bump, so
// older builds refuse the newer config instead of choking on it.
export const MAX_CUSTOM_ACTION_LAYOUT_LENGTH = 32768

// Upper bound (UTF-16 code units) of each text in a custom action's sample
// data. NEVER lower it, for the reason given above.
export const MAX_CUSTOM_ACTION_SAMPLE_TEXT_LENGTH = 32768

// Independent output contract for BYOK structured responses.
export const selectionToolbarCustomActionOutputTypeSchema = z.enum(["string", "number"])

export const selectionToolbarCustomActionOutputFieldSchema = z.object({
  id: z.string().nonempty(),
  name: z.string().trim().min(1),
  type: selectionToolbarCustomActionOutputTypeSchema,
  description: z.string(),
})

// Inert sample data retained for legacy imports and action duplication.
// Values are keyed by field id so renaming fields preserves user-authored data.
export const selectionToolbarCustomActionSampleDataSchema = z.object({
  selection: z.string().max(MAX_CUSTOM_ACTION_SAMPLE_TEXT_LENGTH),
  targetCode: langCodeISO6393Schema,
  values: z.record(z.string(), z.string().max(MAX_CUSTOM_ACTION_SAMPLE_TEXT_LENGTH)),
})

export const selectionToolbarBuiltInActionStateSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().nonempty(),
  // Missing means the action's default key (BUILT_IN_ACTION_DEFAULT_SHORTCUTS);
  // empty means the user cleared it.
  shortcut: shortcutSchema.optional(),
})

export const selectionToolbarBuiltInActionsSchema = z.object({
  dictionary: selectionToolbarBuiltInActionStateSchema,
  // `.default()` is load-bearing: a config stored before v104 still parses in
  // UI contexts that load ahead of the background migration, instead of
  // falling back to DEFAULT_CONFIG and writing that over the user's settings.
  sentenceAnalysis: selectionToolbarBuiltInActionStateSchema.default(() => ({
    enabled: true,
    providerId: "unconfigured",
  })),
})

export const selectionToolbarCustomActionSchema = z
  .object({
    id: z.string().nonempty(),
    name: z.string().nonempty(),
    enabled: z.boolean().optional(),
    icon: z.string(),
    providerId: z.string().nonempty(),
    systemPrompt: z.string(),
    prompt: z.string(),
    outputSchema: z.array(selectionToolbarCustomActionOutputFieldSchema).min(1),
    // Runs the action on the selection. Missing or empty: no key. A custom
    // action starts with none; a built-in one reads its key from its state.
    shortcut: shortcutSchema.optional(),
    // Legacy template accepted as inert data for config compatibility. Never executed.
    layout: z.string().max(MAX_CUSTOM_ACTION_LAYOUT_LENGTH).optional(),
    // Malformed legacy samples must not reset otherwise valid user settings.
    sampleData: selectionToolbarCustomActionSampleDataSchema.optional().catch(undefined),
  })
  .superRefine((action, ctx) => {
    const nameSet = new Set<string>()

    action.outputSchema.forEach((field, index) => {
      if (nameSet.has(field.name)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate output schema name "${field.name}".`,
          path: ["outputSchema", index, "name"],
        })
        return
      }
      nameSet.add(field.name)
    })
  })

export const selectionToolbarCustomActionsSchema = z
  .array(selectionToolbarCustomActionSchema)
  .superRefine((actions, ctx) => {
    const idSet = new Set<string>()
    actions.forEach((action, index) => {
      if (isBuiltInActionId(action.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Action id "${action.id}" is reserved for a built-in action.`,
          path: [index, "id"],
        })
      }

      if (idSet.has(action.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate action id "${action.id}"`,
          path: [index, "id"],
        })
      }
      idSet.add(action.id)
    })

    const nameSet = new Set<string>()
    actions.forEach((action, index) => {
      if (nameSet.has(action.name)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate action name "${action.name}"`,
          path: [index, "name"],
        })
      }
      nameSet.add(action.name)
    })
  })

// TODO: make these vairbale shorter by deleteing SelectionToolbar or "selectionToolbar"
export type SelectionToolbarCustomActionOutputType = z.infer<
  typeof selectionToolbarCustomActionOutputTypeSchema
>
export type SelectionToolbarCustomActionOutputField = z.infer<
  typeof selectionToolbarCustomActionOutputFieldSchema
>
export type SelectionToolbarCustomActionSampleData = z.infer<
  typeof selectionToolbarCustomActionSampleDataSchema
>
export type SelectionToolbarBuiltInActionState = z.infer<
  typeof selectionToolbarBuiltInActionStateSchema
>
export type SelectionToolbarBuiltInActions = z.infer<typeof selectionToolbarBuiltInActionsSchema>
export type SelectionToolbarCustomAction = z.infer<typeof selectionToolbarCustomActionSchema>
