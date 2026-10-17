import type { TestSeriesObject } from "./example/types"
import { describe, expect, it } from "vitest"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import { getObjectWithoutAPIKeys, hasAPIKey } from "../api"
import { LATEST_SCHEMA_VERSION } from "../migration"

/**
 * Reads a fixture without the code under test: every property named `apiKey` (whatever its value,
 * even `undefined`; its subtree is not read) and every other value by path. An empty object or
 * array counts as a value, and so does an object that holds nothing but `apiKey` (v004's
 * `providersConfig.deepseek`): redaction leaves it as `{}`, and losing it would be noticed.
 */
function readConfig(root: unknown) {
  const secrets: { path: string; value: unknown }[] = []
  const ordinary = new Map<string, unknown>()
  const visit = (node: unknown, path: string) => {
    if (node === null || typeof node !== "object") {
      if (node !== undefined) ordinary.set(path, node)
      return
    }
    let kept = 0
    for (const [key, child] of Object.entries(node)) {
      const childPath = Array.isArray(node) ? `${path}[${key}]` : `${path}.${key}`
      if (key === "apiKey") {
        secrets.push({ path: childPath, value: child })
        continue
      }
      kept++
      visit(child, childPath)
    }
    if (kept === 0) ordinary.set(path, Array.isArray(node) ? [] : {})
  }
  visit(root, "$")
  return { secrets, ordinary: Object.fromEntries(ordinary) }
}

describe("config utilities", () => {
  describe("getObjectWithoutAPIKeys", () => {
    for (let version = 2; version <= LATEST_SCHEMA_VERSION; version++) {
      const currentVersionStr = String(version).padStart(3, "0")

      it(`should remove api keys from config v${currentVersionStr}`, async () => {
        const versionLabel = `v${currentVersionStr}`
        // These version modules export `testSeries` (named scenarios, each with a `config`).
        const { testSeries } = (await import(`./example/v${currentVersionStr}.ts`)) as {
          testSeries?: TestSeriesObject
        }
        expect(testSeries, `${versionLabel} must export testSeries`).toBeDefined()
        const seriesEntries = Object.entries(testSeries!)
        expect(
          seriesEntries.length,
          `${versionLabel} testSeries must hold at least one series`,
        ).toBeGreaterThan(0)

        let secretsBeforeRedaction = 0
        for (const [seriesName, series] of seriesEntries) {
          const label = `${versionLabel} series "${seriesName}"`
          const input = series.config
          expect(
            input !== null && typeof input === "object",
            `${label}: the fixture config must be an object, not ${String(input)}`,
          ).toBe(true)

          const snapshot = structuredClone(input)
          const before = readConfig(input)
          const planted = before.secrets.filter(({ value }) => Boolean(value))
          secretsBeforeRedaction += planted.length
          expect(
            Object.keys(before.ordinary).length,
            `${label}: the fixture must hold non-secret values to preserve`,
          ).toBeGreaterThan(0)
          // The detector must see what is planted, or `hasAPIKey(result) === false` below proves nothing.
          expect(hasAPIKey(input), `${label}: hasAPIKey on the unredacted fixture`).toBe(
            planted.length > 0,
          )

          const result = getObjectWithoutAPIKeys(input)
          const after = readConfig(result)

          expect(
            after.secrets.map(({ path }) => path),
            `${label}: apiKey properties left after redaction`,
          ).toEqual([])
          expect(hasAPIKey(result), `${label}: hasAPIKey after redaction`).toBe(false)
          expect(after.ordinary, `${label}: non-secret values lost or changed`).toEqual(
            before.ordinary,
          )
          expect(result, `${label}: the result must be a copy`).not.toBe(input)
          expect(input, `${label}: the fixture was changed by the redaction`).toStrictEqual(
            snapshot,
          )
        }
        expect(
          secretsBeforeRedaction,
          `${versionLabel} must plant at least one non-empty apiKey before redaction`,
        ).toBeGreaterThan(0)
      })
    }

    it("should remove apiKey from OpenAI provider config", () => {
      const openaiConfigFromConstants = DEFAULT_PROVIDER_CONFIG.openai
      const openaiConfigWithApiKey = {
        ...openaiConfigFromConstants,
        apiKey: "sk-1234567890abcdef",
      }

      const result = getObjectWithoutAPIKeys(openaiConfigWithApiKey)

      expect(result).not.toHaveProperty("apiKey")
      expect(result.name).toBe(openaiConfigFromConstants.name)
      expect(result.provider).toBe("openai")
      expect(result.model).toEqual(openaiConfigFromConstants.model)
      expect(hasAPIKey(result)).toBe(false)
    })

    it("should remove apiKey from DeepSeek provider config", () => {
      const deepseekConfigFromConstants = DEFAULT_PROVIDER_CONFIG.deepseek
      const deepseekConfigWithApiKey = {
        ...deepseekConfigFromConstants,
        apiKey: "sk-deepseek-123",
        baseURL: "https://api.deepseek.com",
      }

      const result = getObjectWithoutAPIKeys(deepseekConfigWithApiKey)

      expect(result).not.toHaveProperty("apiKey")
      expect(result.name).toBe(deepseekConfigFromConstants.name)
      expect(result.provider).toBe("deepseek")
      expect(result.model).toEqual(deepseekConfigFromConstants.model)
      expect(hasAPIKey(result)).toBe(false)
    })

    it("should handle nested objects with multiple apiKeys", () => {
      const nestedObject = {
        user: {
          name: "John",
          apiKey: "user-secret-123",
          profile: {
            email: "john@example.com",
            apiKey: "profile-secret-456",
          },
        },
        services: {
          openai: {
            apiKey: "sk-openai-789",
            model: "gpt-4",
          },
          deepseek: {
            apiKey: "sk-deepseek-xyz",
            url: "https://api.deepseek.com",
          },
        },
        apiKey: "root-secret-abc",
      }

      const result = getObjectWithoutAPIKeys(nestedObject)

      expect(result).not.toHaveProperty("apiKey")
      expect(result.user).not.toHaveProperty("apiKey")
      expect(result.user.profile).not.toHaveProperty("apiKey")
      expect(result.services.openai).not.toHaveProperty("apiKey")
      expect(result.services.deepseek).not.toHaveProperty("apiKey")

      expect(result.user.name).toBe("John")
      expect(result.user.profile.email).toBe("john@example.com")
      expect(result.services.openai.model).toBe("gpt-4")
      expect(result.services.deepseek.url).toBe("https://api.deepseek.com")
      expect(hasAPIKey(result)).toBe(false)
    })

    it("should handle arrays containing objects with apiKeys", () => {
      const arrayObject = {
        providers: [
          {
            name: "Provider 1",
            apiKey: "key-1",
            enabled: true,
          },
          {
            name: "Provider 2",
            apiKey: "key-2",
            enabled: false,
          },
        ],
        settings: {
          apiKey: "settings-key",
          theme: "dark",
        },
      }

      const result = getObjectWithoutAPIKeys(arrayObject)

      expect(result.providers[0]).not.toHaveProperty("apiKey")
      expect(result.providers[1]).not.toHaveProperty("apiKey")
      expect(result.settings).not.toHaveProperty("apiKey")

      expect(result.providers[0]!.name).toBe("Provider 1")
      expect(result.providers[0]!.enabled).toBe(true)
      expect(result.providers[1]!.name).toBe("Provider 2")
      expect(result.providers[1]!.enabled).toBe(false)
      expect(result.settings.theme).toBe("dark")
      expect(hasAPIKey(result)).toBe(false)
    })

    it("should handle objects without apiKeys", () => {
      const cleanObject = {
        name: "Test",
        config: {
          enabled: true,
          settings: {
            theme: "light",
            language: "en",
          },
        },
        items: ["item1", "item2"],
      }

      const result = getObjectWithoutAPIKeys(cleanObject)

      expect(result).toEqual(cleanObject)
      expect(hasAPIKey(result)).toBe(false)
    })

    it("should handle edge cases and complex structures", () => {
      // Test empty object
      const emptyObject = {}
      expect(getObjectWithoutAPIKeys(emptyObject)).toEqual({})
      expect(hasAPIKey(getObjectWithoutAPIKeys(emptyObject))).toBe(false)

      // Test object with only apiKey
      const onlyApiKeyObject = { apiKey: "secret" }
      const result = getObjectWithoutAPIKeys(onlyApiKeyObject)
      expect(result).toEqual({})
      expect(hasAPIKey(result)).toBe(false)

      // Test deeply nested structure
      const complexObject = {
        level1: {
          level2: {
            level3: {
              apiKey: "deep-secret",
              data: "keep-this",
              level4: {
                apiKey: "deeper-secret",
                moreData: "also-keep-this",
              },
            },
          },
        },
        otherBranch: {
          apiKey: "branch-secret",
          info: "preserve-this",
        },
      }

      const cleanResult = getObjectWithoutAPIKeys(complexObject)
      expect(cleanResult.level1.level2.level3).not.toHaveProperty("apiKey")
      expect(cleanResult.level1.level2.level3.level4).not.toHaveProperty("apiKey")
      expect(cleanResult.otherBranch).not.toHaveProperty("apiKey")
      expect(cleanResult.level1.level2.level3.data).toBe("keep-this")
      expect(cleanResult.level1.level2.level3.level4.moreData).toBe("also-keep-this")
      expect(cleanResult.otherBranch.info).toBe("preserve-this")
      expect(hasAPIKey(cleanResult)).toBe(false)
    })
  })
})
