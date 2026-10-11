import type { LangCodeISO6393 } from "@/lib/languages"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import { franc } from "franc"
import { toastManager } from "@/components/ui/base-ui/toast"
import { langCodeISO6393Schema } from "@/lib/languages"
import { getLocalConfig } from "@/utils/config/storage"
import { i18n } from "@/utils/i18n"
import { logger } from "@/utils/logger"
import { sendMessage } from "@/utils/message"
import {
  getLanguageDetectionSystemPrompt,
  parseDetectedLanguageCode,
} from "@/utils/prompts/language-detection"
import { serializeProviderRef } from "@/utils/providers/provider-ref"
import { resolveProviderRefForCapability } from "@/utils/providers/provider-registry"
import { cleanText } from "./utils"

const DEFAULT_MIN_LENGTH = 10
const DEFAULT_MAX_LENGTH_FOR_LLM = 500
const LLM_DETECTION_FALLBACK_TOAST_ID = "llm-detection-fallback"

export type DetectionSource = "llm" | "franc" | "fallback"

export interface DetectLanguageOptions {
  /** Minimum text length to attempt detection (default: 10) */
  minLength?: number
  /** Enable LLM detection */
  enableLLM?: boolean
  /** Provider to run LLM detection on; resolved from config when omitted. */
  providerRef?: PromptableProviderRef
  /** Max text length for LLM detection (default: 500) */
  maxLengthForLLM?: number
}

export interface DetectLanguageResult {
  code: LangCodeISO6393 | "und"
  source: DetectionSource
}

/**
 * Detect language of text using franc, with optional LLM enhancement.
 * Returns both the detected code and the detection source.
 * @param text - Text to detect language for
 * @param options - Detection options
 * @returns Detection result with code and source
 */
export async function detectLanguageWithSource(
  text: string,
  options?: DetectLanguageOptions,
): Promise<DetectLanguageResult> {
  const trimmedText = text.trim()
  const minLength = options?.minLength ?? DEFAULT_MIN_LENGTH

  if (trimmedText.length < minLength) {
    return { code: "und", source: "fallback" }
  }

  // Try LLM detection first if enabled
  if (options?.enableLLM) {
    try {
      const maxLength = options.maxLengthForLLM ?? DEFAULT_MAX_LENGTH_FOR_LLM
      const textForLLM = cleanText(trimmedText, maxLength)
      const llmResult = await detectLanguageWithLLM(textForLLM, options?.providerRef)
      if (llmResult && llmResult !== "und") {
        return { code: llmResult, source: "llm" }
      }
    } catch (error) {
      logger.warn("LLM detection failed, falling back to franc:", error)
      toastManager.add({
        type: "warning",
        title: i18n.t("languageDetection.llmFailed"),
        id: LLM_DETECTION_FALLBACK_TOAST_ID,
      })
    }
  }

  // Fallback to franc
  const francResult = franc(trimmedText)
  if (francResult === "und") {
    return { code: "und", source: "fallback" }
  }

  const parsedFrancResult = langCodeISO6393Schema.safeParse(francResult)
  if (!parsedFrancResult.success) {
    return { code: "und", source: "fallback" }
  }

  return { code: parsedFrancResult.data, source: "franc" }
}

/**
 * Detect language of text using franc, with optional LLM enhancement.
 * @param text - Text to detect language for
 * @param options - Detection options
 * @returns Detected language code or null if detection failed
 */
export async function detectLanguage(
  text: string,
  options?: DetectLanguageOptions,
): Promise<LangCodeISO6393 | null> {
  const result = await detectLanguageWithSource(text, options)
  return result.code === "und" ? null : result.code
}

/**
 * Detect language using LLM with retry logic
 * @param text - Text to analyze (caller is responsible for combining title and content)
 * @param providerRef - Optional provider ref (resolved from global config when omitted)
 * @returns ISO 639-3 language code or null if all attempts fail (null = no LLM provider or all attempts failed)
 */
export async function detectLanguageWithLLM(
  text: string,
  providerRef?: PromptableProviderRef,
): Promise<LangCodeISO6393 | "und" | null> {
  const MAX_ATTEMPTS = 3 // 1 original + 2 retries

  if (!text.trim()) {
    logger.warn("No text provided for language detection")
    return null
  }

  // Resolve only the explicitly configured provider.
  let ref: PromptableProviderRef | undefined = providerRef

  if (!ref) {
    try {
      const globalConfig = await getLocalConfig()
      if (!globalConfig) {
        logger.warn("No config found for language detection")
        return null
      }
      const ldProviderId = globalConfig.languageDetection.providerId
      if (!ldProviderId) {
        logger.info("No provider configured for language detection")
        return null
      }
      const resolved = resolveProviderRefForCapability(
        "languageDetection",
        globalConfig.providersConfig,
        ldProviderId,
      )
      if (!resolved) {
        logger.info(`Provider "${ldProviderId}" cannot run language detection`)
        return null
      }
      ref = await serializeProviderRef(resolved, "languageDetection")
    } catch (error) {
      logger.error("Failed to resolve the language detection provider:", error)
      return null
    }
  }

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await sendMessage("backgroundGenerateText", {
          providerRef: ref,
          instructions: getLanguageDetectionSystemPrompt(),
          prompt: text,
          maxRetries: 0,
        })
        const detectedCode = parseDetectedLanguageCode(response.text)

        if (detectedCode) {
          logger.info(`LLM language detection succeeded on attempt ${attempt}: ${detectedCode}`)
          return detectedCode
        }
        logger.warn(`LLM returned invalid language code on attempt ${attempt}: "${response.text}"`)
      } catch (error) {
        logger.error(`LLM language detection attempt ${attempt}/${MAX_ATTEMPTS} failed:`, error)
      }

      if (attempt === MAX_ATTEMPTS) {
        logger.warn("All LLM language detection attempts failed")
        return null
      }
    }
  } catch (error) {
    logger.error("Language detection failed:", error)
    return null
  }

  return null
}
