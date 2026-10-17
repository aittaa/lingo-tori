import type { LangCodeISO6391 } from "@/lib/languages"
import type { ProviderConfig } from "@/types/config/provider"
import type { TranslationTextFormat } from "@/types/config/translate"
import type { ApiUsageFeature } from "@/utils/api-usage"
import type { ApiUsageIdentity } from "@/utils/api-usage-identity"
import { createApiUsageIdentity } from "@/utils/api-usage-identity"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import {
  isDataConsentRequiredError,
  providerConfigCarriesCredentials,
} from "@/utils/firefox-data-consent"
import { createProviderFetch } from "@/utils/providers/provider-fetch"

type DeepLXProviderConfig = Extract<ProviderConfig, { provider: "deeplx" }>
const API_KEY_PLACEHOLDER_RE = /\{\{apiKey\}\}/g

export async function deeplxTranslate(
  sourceText: string,
  fromLang: LangCodeISO6391 | "auto",
  toLang: LangCodeISO6391,
  providerConfig: DeepLXProviderConfig,
  options?: {
    usageFeature?: ApiUsageFeature
    textFormat?: TranslationTextFormat
    signal?: AbortSignal
  },
): Promise<string> {
  const baseURL = providerConfig.baseURL || DEFAULT_PROVIDER_CONFIG.deeplx.baseURL
  const apiKey = providerConfig.apiKey

  if (!baseURL) {
    throw new Error("DeepLX baseURL is not configured")
  }

  const formatLang = (lang: LangCodeISO6391 | "auto") => {
    if (lang === "auto") return "auto"
    let formattedLang = lang.toUpperCase()
    if (formattedLang === "ZH-CN") formattedLang = "ZH"
    if (formattedLang === "ZH-TW") formattedLang = "ZH-HANT"
    return formattedLang
  }

  const url = buildDeepLXUrl(baseURL, apiKey)

  const requestBody = JSON.stringify({
    text: sourceText,
    source_lang: formatLang(fromLang),
    target_lang: formatLang(toLang),
    ...(options?.textFormat === "html" ? { tag_handling: "html" } : {}),
  })

  const fetchResponse = await fetchDirect(
    url,
    requestBody,
    options?.signal,
    options?.usageFeature,
    options?.usageFeature ? createApiUsageIdentity(providerConfig) : undefined,
    // DeepLX sends the key only inside the URL (the `{{apiKey}}` placeholder), where the request
    // itself does not show it, so the configuration has to say so.
    providerConfigCarriesCredentials({
      baseURL,
      apiKey: baseURL.includes("{{apiKey}}") ? apiKey : undefined,
      endpointNeedsConsent: providerConfig.endpointNeedsConsent,
    }),
  )

  return parseDeepLXResponse(fetchResponse)
}

async function fetchDirect(
  url: string,
  body: string,
  signal: AbortSignal | undefined,
  usageFeature: ApiUsageFeature | undefined,
  identity: ApiUsageIdentity | undefined,
  credentialed: boolean,
) {
  const resp = await createProviderFetch({
    feature: usageFeature,
    identity,
    credentialed,
  })(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal,
  }).catch((error) => {
    // A refusal for missing consent is not a network failure: say what it is.
    if (isDataConsentRequiredError(error)) throw error
    throw new Error(`Network error during DeepLX translation: ${error.message}`)
  })

  return resp
}

async function parseDeepLXResponse(resp: {
  ok: boolean
  status: number
  statusText: string
  text: () => Promise<string>
  json: () => Promise<any>
}) {
  if (!resp.ok) {
    const errorText = await resp.text().catch(() => "Unable to read error response")
    throw new Error(
      `DeepLX translation request failed: ${resp.status} ${resp.statusText}${
        errorText ? ` - ${errorText}` : ""
      }`,
    )
  }

  try {
    const result = await resp.json()
    if (typeof result?.data !== "string") {
      throw new TypeError("Unexpected response format from DeepLX translation API")
    }
    return result.data
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse DeepLX translation response: ${message}`, { cause: error })
  }
}

export function buildDeepLXUrl(baseURL: string, apiKey?: string): string {
  if (baseURL.includes("{{apiKey}}")) {
    const normalizedApiKey = apiKey?.trim()
    if (!normalizedApiKey) {
      throw new Error("API key is required when using {{apiKey}} placeholder in DeepLX baseURL")
    }
    return baseURL.replace(API_KEY_PLACEHOLDER_RE, normalizedApiKey)
  }

  return baseURL
}
