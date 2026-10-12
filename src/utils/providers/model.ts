import type { Config } from "@/types/config/config"
import type {
  AzureApiMode,
  DedicatedLLMProviderTypes,
  LLMProviderConfig,
} from "@/types/config/provider"
import type { ApiUsageFeature } from "@/utils/api-usage"
import { createAlibaba } from "@ai-sdk/alibaba"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createAzure } from "@ai-sdk/azure"
import { createCerebras } from "@ai-sdk/cerebras"
import { createCohere } from "@ai-sdk/cohere"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { createFireworks } from "@ai-sdk/fireworks"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createGroq } from "@ai-sdk/groq"
import { createHuggingFace } from "@ai-sdk/huggingface"
import { createMistral } from "@ai-sdk/mistral"
import { createMoonshotAI } from "@ai-sdk/moonshotai"
import { createOpenResponses } from "@ai-sdk/open-responses"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createPerplexity } from "@ai-sdk/perplexity"
import { createReplicate } from "@ai-sdk/replicate"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createXai } from "@ai-sdk/xai"
import { createOllama } from "ai-sdk-ollama"
import { match } from "ts-pattern"
import { storage } from "#imports"
import {
  DEFAULT_AZURE_API_MODE,
  isDedicatedLLMProviderConfig,
  isOpenAICompatibleLLMProviderConfig,
  isOpenResponsesLLMProviderConfig,
} from "@/types/config/provider"
import { compactObject } from "@/types/utils"
import { createApiUsageIdentity, registerApiUsageModel } from "@/utils/api-usage-identity"
import { withApiUsage } from "@/utils/api-usage-tracking"
import { createByosModel } from "@/utils/byos/model"
import { getLLMProvidersConfig, getProviderConfigById } from "../config/helpers"
import { CONFIG_STORAGE_KEY } from "../constants/config"
import { getProviderHeadersWithOverride } from "./headers"
import { resolveModelId } from "./model-id"
import { ProviderSetupError } from "./provider-setup-error"

const DEDICATED_PROVIDER_FACTORY_BY_TYPE = {
  openai: createOpenAI,
  azure: createAzure,
  deepseek: createDeepSeek,
  google: createGoogleGenerativeAI,
  anthropic: createAnthropic,
  xai: createXai,
  bedrock: createAmazonBedrock,
  groq: createGroq,
  deepinfra: createDeepInfra,
  mistral: createMistral,
  togetherai: createTogetherAI,
  cohere: createCohere,
  fireworks: createFireworks,
  cerebras: createCerebras,
  replicate: createReplicate,
  perplexity: createPerplexity,
  ollama: createOllama,
  alibaba: createAlibaba,
  moonshotai: createMoonshotAI,
  huggingface: createHuggingFace,
} as const satisfies Record<DedicatedLLMProviderTypes, unknown>

function getProviderSpecificSettings(providerConfig: LLMProviderConfig) {
  const settings =
    "providerSpecificSettings" in providerConfig
      ? compactObject(providerConfig.providerSpecificSettings ?? {})
      : {}

  if (providerConfig.provider !== "azure") {
    return settings
  }

  const { apiMode: _apiMode, ...azureSettings } = settings as Record<string, unknown>
  return azureSettings
}

function getAzureApiMode(providerConfig: LLMProviderConfig): AzureApiMode {
  if (providerConfig.provider !== "azure") {
    return DEFAULT_AZURE_API_MODE
  }

  const apiMode = (providerConfig.providerSpecificSettings as { apiMode?: unknown } | undefined)
    ?.apiMode
  return apiMode === "chat" ? "chat" : DEFAULT_AZURE_API_MODE
}

async function getLanguageModelById(providerId: string, usageFeature?: ApiUsageFeature) {
  const config = await storage.getItem<Config>(`local:${CONFIG_STORAGE_KEY}`)
  if (!config) {
    throw new ProviderSetupError("Config not found")
  }

  const LLMProvidersConfig = getLLMProvidersConfig(config.providersConfig)
  const providerConfig = getProviderConfigById(LLMProvidersConfig, providerId)
  if (!providerConfig) {
    throw new ProviderSetupError(`Provider ${providerId} not found`)
  }

  return getLanguageModelForConfig(providerConfig, usageFeature)
}

/**
 * Build a model from a config the caller already holds.
 *
 * Callers that were handed a provider config — a transported `providerRef`, say
 * — must use this rather than looking the id up again: re-reading storage picks
 * up edits made after the ref was captured, so the model would come from the
 * new row while the params derived from the ref came from the old one.
 */
export function getLanguageModelForConfig(
  providerConfig: LLMProviderConfig,
  usageFeature?: ApiUsageFeature,
) {
  if (!providerConfig.enabled) {
    throw new ProviderSetupError("Enable this provider in Settings before using it.")
  }
  const identity = usageFeature ? createApiUsageIdentity(providerConfig) : undefined
  const register = <T>(model: T): T => {
    if (identity) registerApiUsageModel(model, identity)
    return model
  }
  if (providerConfig.provider === "byos") {
    const modelId = resolveModelId(providerConfig.model)
    if (!modelId) throw new ProviderSetupError("Choose a ChatGPT model in Settings.")
    return register(createByosModel(modelId, undefined, usageFeature))
  }
  // Custom/local endpoints may intentionally authenticate outside an API key.
  if (
    isDedicatedLLMProviderConfig(providerConfig) &&
    providerConfig.provider !== "ollama" &&
    providerConfig.provider !== "bedrock" &&
    !providerConfig.baseURL &&
    !providerConfig.apiKey?.trim()
  ) {
    throw new ProviderSetupError("Add your API key in Settings before using this provider.")
  }
  const headers = getProviderHeadersWithOverride(providerConfig.provider, providerConfig.headers)
  const providerSpecificSettings = getProviderSpecificSettings(providerConfig)

  const meteredFetch = usageFeature
    ? { fetch: withApiUsage(usageFeature, undefined, identity) }
    : {}
  const provider = match(providerConfig)
    .when(isOpenAICompatibleLLMProviderConfig, (matchedConfig) =>
      createOpenAICompatible({
        name: matchedConfig.provider,
        baseURL: matchedConfig.baseURL,
        supportsStructuredOutputs: true,
        ...meteredFetch,
        ...(matchedConfig.apiKey && { apiKey: matchedConfig.apiKey }),
        ...(headers && { headers }),
      }),
    )
    .when(isOpenResponsesLLMProviderConfig, (matchedConfig) =>
      createOpenResponses({
        name: matchedConfig.provider,
        url: matchedConfig.url,
        ...meteredFetch,
        ...(matchedConfig.apiKey && { apiKey: matchedConfig.apiKey }),
        ...(headers && { headers }),
      }),
    )
    .when(isDedicatedLLMProviderConfig, (matchedConfig) =>
      DEDICATED_PROVIDER_FACTORY_BY_TYPE[matchedConfig.provider]({
        ...providerSpecificSettings,
        ...meteredFetch,
        ...(matchedConfig.baseURL && { baseURL: matchedConfig.baseURL }),
        ...(matchedConfig.apiKey && { apiKey: matchedConfig.apiKey }),
        ...(headers && { headers }),
      }),
    )
    .exhaustive()

  const modelId = resolveModelId(providerConfig.model)

  if (!modelId) {
    throw new ProviderSetupError("Model is undefined")
  }

  if (providerConfig.provider === "azure" && getAzureApiMode(providerConfig) === "chat") {
    return register((provider as ReturnType<typeof createAzure>).chat(modelId))
  }

  if (providerConfig.provider === "ollama") {
    return register(
      (provider as ReturnType<typeof createOllama>).languageModel(modelId, { think: false }),
    )
  }

  return register(provider.languageModel(modelId))
}

export async function getModelById(providerId: string, usageFeature?: ApiUsageFeature) {
  return getLanguageModelById(providerId, usageFeature)
}
