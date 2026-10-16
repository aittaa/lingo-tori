// One provider row, two versions of it, shared by the tests of the stream paths that must run on the
// configuration the caller captured: version A is what the UI computed its request from, version B
// is the same row (same id) after an edit made while the request was still on its way.
//
// Every field a request is built from differs between the two, so a request that mixes them shows
// up in the outbound call: endpoint, credential, header, model, temperature and provider options.

import type { Config } from "@/types/config/config"
import type { LLMProviderConfig } from "@/types/config/provider"
import { storage } from "#imports"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"

export const PROVIDER_ID = "snapshot-provider"

export function providerRow(version: "a" | "b"): LLMProviderConfig {
  return {
    id: PROVIDER_ID,
    name: `Provider ${version}`,
    provider: "openai-compatible",
    enabled: true,
    baseURL: `https://provider-${version}.example.test/v1`,
    apiKey: `key-${version}`,
    model: { model: "use-custom-model", isCustomModel: true, customModel: `model-${version}` },
    temperature: version === "a" ? 0.2 : 0.9,
    providerOptions: { user: `options-${version}` },
    headers: { "X-Snapshot": version },
  }
}

export function configWith(row: LLMProviderConfig): Config {
  const config = structuredClone(DEFAULT_CONFIG)
  config.providersConfig = [row]
  return config
}

export async function storeProvider(row: LLMProviderConfig | null) {
  await storage.setItem<Config>(
    `local:${CONFIG_STORAGE_KEY}`,
    row ? configWith(row) : { ...configWith(providerRow("a")), providersConfig: [] },
  )
}

/** What one outbound provider request must look like when it was built from version `v` alone. */
export function expectedFrom(version: "a" | "b") {
  return {
    endpoint: `https://provider-${version}.example.test/v1/chat/completions`,
    authorization: `Bearer key-${version}`,
    header: version,
    model: `model-${version}`,
    temperature: version === "a" ? 0.2 : 0.9,
    user: `options-${version}`,
  }
}

export function summarize(request: {
  url: string
  headers: Record<string, string>
  body: Record<string, any>
}) {
  return {
    endpoint: request.url,
    authorization: request.headers.authorization,
    header: request.headers["x-snapshot"],
    model: request.body.model,
    temperature: request.body.temperature,
    user: request.body.user,
  }
}
