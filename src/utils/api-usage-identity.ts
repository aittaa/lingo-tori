import type { ProviderConfig } from "@/types/config/provider"
import { z } from "zod"
import { ALL_PROVIDER_TYPES, isLLMProviderConfig } from "@/types/config/provider"
import { LLM_PROVIDER_MODELS } from "@/utils/constants/models"
import { Sha256Hex } from "@/utils/hash"
import { resolveModelId } from "@/utils/providers/model-id"

const publicModels = new Set<string>(
  Object.values(LLM_PROVIDER_MODELS)
    .flat()
    .filter((model) => model !== "use-custom-model"),
)
const PUBLIC_OPENAI_MODEL =
  /^(?:gpt-\d{1,2}(?:\.\d{1,2})?(?:-(?:sol|astra|luna|terra|pro|mini|nano|codex|chat-latest|preview|instruct|instant|thinking)){0,3}(?:-\d{4}-\d{2}-\d{2})?|o[134](?:-mini)?)$/
const safePublicModel = (value: string) =>
  publicModels.has(value) || PUBLIC_OPENAI_MODEL.test(value)

export const apiUsageIdentitySchema = z
  .strictObject({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    provider: z.enum(ALL_PROVIDER_TYPES),
    providerKey: z.string().regex(/^[a-f0-9]{12}$/),
    transport: z.enum(["api", "byos"]),
    model: z.string().refine(safePublicModel).nullable(),
  })
  .refine((identity) => (identity.provider === "byos") === (identity.transport === "byos"))
export type ApiUsageIdentity = z.infer<typeof apiUsageIdentitySchema>

/** Never read user-facing provider names, URLs, headers, keys or tokens.
 * Unknown/custom model labels remain opaque aliases, not arbitrary persisted text. */
export function createApiUsageIdentity(config: ProviderConfig): ApiUsageIdentity {
  const model = isLLMProviderConfig(config) ? (resolveModelId(config.model) ?? "") : ""
  const providerKey = Sha256Hex(
    config.provider,
    config.provider === "byos" ? "subscription" : config.id,
  ).slice(0, 12)
  return {
    id: Sha256Hex(config.provider, providerKey, model),
    provider: config.provider,
    providerKey,
    transport: config.provider === "byos" ? "byos" : "api",
    model: safePublicModel(model) ? model : null,
  }
}

const modelIdentities = new WeakMap<object, ApiUsageIdentity>()
export function registerApiUsageModel(model: unknown, identity: ApiUsageIdentity) {
  if (model !== null && typeof model === "object") modelIdentities.set(model, identity)
}
export function getApiUsageModelIdentity(model: unknown): ApiUsageIdentity | undefined {
  return model !== null && typeof model === "object" ? modelIdentities.get(model) : undefined
}
