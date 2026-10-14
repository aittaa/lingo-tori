import type { TranslatePromptResult } from "../translate"
import type { Config } from "@/types/config/config"
import type { MatchedTerm } from "@/utils/glossary/types"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import {
  DEFAULT_BATCH_TRANSLATE_PROMPT,
  DEFAULT_SENTINEL_TRANSLATE_PROMPT,
  DEFAULT_TRANSLATE_PROMPT_ID,
  isNoTranslationSentinel,
  NO_TRANSLATION_SENTINEL,
  PRECISION_REWRITE_TRANSLATE_PROMPT_ID,
} from "@/utils/constants/prompt"
import { appendGlossaryToSystemPrompt } from "@/utils/glossary/prompt"
import { HTML_ATTRIBUTE_MARKER } from "@/utils/host/translate/html-attribute-markers"
import { getSubtitlesTranslatePrompt } from "../subtitles"
import { getTranslatePromptFromConfig } from "../translate"

vi.mock("@/utils/config/storage", () => ({
  getLocalConfig: vi.fn<(...args: any[]) => any>(),
}))

let mockGetLocalConfig: any

const defaultTranslatePromptConfig: Pick<Config["pageTranslation"], "customPromptsConfig"> = {
  customPromptsConfig: {
    promptId: DEFAULT_TRANSLATE_PROMPT_ID,
    patterns: [],
  },
}

describe("translate prompt tokens", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockGetLocalConfig = vi.mocked((await import("@/utils/config/storage")).getLocalConfig)
  })

  it("replaces new translate prompt tokens from config", () => {
    const config: Pick<Config["pageTranslation"], "customPromptsConfig"> = {
      customPromptsConfig: {
        promptId: "custom-prompt",
        patterns: [
          {
            id: "custom-prompt",
            name: "Custom",
            systemPrompt:
              "Target {{targetLanguage}} | Title {{webTitle}} | Description {{webDescription}} | Content {{webContent}} | Summary {{webSummary}}",
            prompt:
              "Translate {{input}} for {{targetLanguage}} with {{webTitle}} / {{webDescription}} / {{webContent}} / {{webSummary}}",
          },
        ],
      },
    }

    const result = getTranslatePromptFromConfig(config, "English", "Hola", {
      context: {
        webTitle: "Article Title",
        webDescription: "Article Description",
        webContent: "Article Content",
        webSummary: "Article Summary",
      },
    })

    expect(result.systemPrompt).toBe(
      "Target English | Title Article Title | Description Article Description | Content Article Content | Summary Article Summary",
    )
    expect(result.prompt).toBe(
      "Translate Hola for English with Article Title / Article Description / Article Content / Article Summary",
    )
  })

  it("does not replace legacy translate prompt tokens at runtime", () => {
    const config: Pick<Config["pageTranslation"], "customPromptsConfig"> = {
      customPromptsConfig: {
        promptId: "legacy-prompt",
        patterns: [
          {
            id: "legacy-prompt",
            name: "Legacy",
            systemPrompt: "Legacy {{targetLang}} {{title}} {{summary}}",
            prompt: "Translate {{input}} to {{targetLang}}",
          },
        ],
      },
    }

    const result = getTranslatePromptFromConfig(config, "English", "Hola", {
      context: {
        webTitle: "Article Title",
        webDescription: "Article Description",
        webSummary: "Article Summary",
      },
    })

    expect(result.systemPrompt).toBe("Legacy {{targetLang}} {{title}} {{summary}}")
    expect(result.prompt).toBe("Translate Hola to {{targetLang}}")
  })

  it("uses the product default built-in prompt", () => {
    const result = getTranslatePromptFromConfig(defaultTranslatePromptConfig, "Japanese", "Hello", {
      context: {
        webTitle: "Prompt test title",
        webSummary: "Prompt test summary",
      },
    })

    expect(result.systemPrompt).toContain("You are a professional Japanese native translator")
    expect(result.systemPrompt).not.toContain("{{targetLang}}")
    expect(result.systemPrompt).not.toContain("{{title}}")
    expect(result.systemPrompt).not.toContain("{{summary}}")
    expect(result.prompt).toContain("Hello")
  })

  it("uses precision-rewrite when that built-in prompt is selected", () => {
    const result = getTranslatePromptFromConfig(
      {
        customPromptsConfig: {
          promptId: PRECISION_REWRITE_TRANSLATE_PROMPT_ID,
          patterns: [],
        },
      },
      "French",
      "Hello",
      {
        context: {
          webTitle: "English-only prompt test",
          webSummary: "English-only prompt summary",
        },
      },
    )

    expect(result.systemPrompt).toContain("Elite Translator and Rewriting Expert")
    expect(result.systemPrompt).toContain("Perform these steps internally without revealing them")
    expect(result.systemPrompt).toContain("Output only the final translation")
    expect(result.systemPrompt).not.toMatch(/\p{Script=Han}/u)
    expect(result.prompt).not.toMatch(/\p{Script=Han}/u)
  })

  it("uses a selected custom prompt", () => {
    const result = getTranslatePromptFromConfig(
      {
        customPromptsConfig: {
          promptId: "mine",
          patterns: [
            {
              id: "mine",
              name: "Mine",
              systemPrompt: "My custom system prompt",
              prompt: "My custom prompt: {{input}}",
            },
          ],
        },
      },
      "English",
      "Hola",
    )

    expect(result).toEqual({
      systemPrompt: "My custom system prompt",
      prompt: "My custom prompt: Hola",
    })
  })

  it("falls back to the product default for an unknown prompt id", () => {
    const result = getTranslatePromptFromConfig(
      {
        customPromptsConfig: {
          promptId: "missing-prompt",
          patterns: [],
        },
      },
      "Japanese",
      "Hello",
    )

    expect(result.systemPrompt).toContain("You are a professional Japanese native translator")
    expect(result.prompt).toContain("Hello")
  })

  it("appends mandatory marker rules to the default system prompt", () => {
    const input = `<span ${HTML_ATTRIBUTE_MARKER}="0">Hello</span>`

    const result = getTranslatePromptFromConfig(defaultTranslatePromptConfig, "Chinese", input)

    expect(result.systemPrompt).toContain("## Protected HTML Marker Rules")
    expect(result.systemPrompt).toContain(
      `preserve every \`${HTML_ATTRIBUTE_MARKER}\` attribute occurrence and its value exactly once`,
    )
    expect(result.systemPrompt).toContain("may move within its segment")
    expect(result.prompt).toContain(input)
  })

  it("appends mandatory marker rules after a custom system prompt", () => {
    const config: Pick<Config["pageTranslation"], "customPromptsConfig"> = {
      customPromptsConfig: {
        promptId: "custom-prompt",
        patterns: [
          {
            id: "custom-prompt",
            name: "Custom",
            systemPrompt: "Custom instructions that omit marker handling.",
            prompt: "Translate {{input}} to {{targetLanguage}}.",
          },
        ],
      },
    }
    const input = `<a ${HTML_ATTRIBUTE_MARKER}="7">Read more</a>`

    const result = getTranslatePromptFromConfig(config, "Japanese", input)

    expect(result.systemPrompt).toMatch(/^Custom instructions that omit marker handling\./)
    expect(result.systemPrompt.indexOf("## Protected HTML Marker Rules")).toBeGreaterThan(
      result.systemPrompt.indexOf("Custom instructions that omit marker handling."),
    )
  })

  it("keeps marker rules segment-scoped and after batch rules", () => {
    const input = `<span ${HTML_ATTRIBUTE_MARKER}="0">First</span>\n\n%%\n\n<a ${HTML_ATTRIBUTE_MARKER}="0">Second</a>`

    const result = getTranslatePromptFromConfig(defaultTranslatePromptConfig, "French", input, {
      isBatch: true,
    })

    const batchRulesIndex = result.systemPrompt.indexOf("## Multi-paragraph Translation Rules")
    const markerRulesIndex = result.systemPrompt.indexOf("## Protected HTML Marker Rules")
    expect(batchRulesIndex).toBeGreaterThan(-1)
    expect(markerRulesIndex).toBeGreaterThan(batchRulesIndex)
    expect(result.systemPrompt).toContain(
      "segments are separated by a standalone %% line when present",
    )
    expect(result.systemPrompt).toContain("move a marker to another segment")
  })

  it.each([
    ["plain text", "Hello world"],
    ["unmarked HTML", '<span class="message">Hello</span>'],
    ["a marker name mentioned as text", `Explain ${HTML_ATTRIBUTE_MARKER} to me`],
    [
      "a marker-like string inside another attribute",
      `<span title='preserve ${HTML_ATTRIBUTE_MARKER}="0" exactly'>Hello</span>`,
    ],
  ])("does not append marker rules for %s", (_case, input) => {
    const result = getTranslatePromptFromConfig(defaultTranslatePromptConfig, "Chinese", input)

    expect(result.systemPrompt).not.toContain("## Protected HTML Marker Rules")
  })

  it("appends placeholder rules only when the input carries an inline atom token", () => {
    const withToken = getTranslatePromptFromConfig(
      defaultTranslatePromptConfig,
      "Chinese",
      "Let {{0}} be the mean.",
    )
    expect(withToken.systemPrompt).toContain("## Protected Placeholder Rules")
    expect(withToken.systemPrompt).toContain("may move within its segment")
    expect(withToken.systemPrompt).not.toMatch(/Rules[\s\S]*\{\{\d+\}\}/)

    const without = getTranslatePromptFromConfig(
      defaultTranslatePromptConfig,
      "Chinese",
      "Let x be the mean.",
    )
    expect(without.systemPrompt).not.toContain("## Protected Placeholder Rules")
    // Byte-identical to the pre-feature prompt: the LLM cache hash of every
    // paragraph without atoms must not change.
    expect(without.systemPrompt).toBe(
      getTranslatePromptFromConfig(defaultTranslatePromptConfig, "Chinese", "other").systemPrompt,
    )
  })

  it.each([
    ["the no-translation sentinel", `Prefix ${NO_TRANSLATION_SENTINEL}`],
    ["a template literal with spaces", "Use {{ count }} in the template"],
    ["a named prompt token", "Translate {{input}} please"],
    ["a single-brace literal", "Format {0} here"],
  ])("does not append placeholder rules for %s", (_case, input) => {
    const result = getTranslatePromptFromConfig(defaultTranslatePromptConfig, "Chinese", input)

    expect(result.systemPrompt).not.toContain("## Protected Placeholder Rules")
  })

  it("orders placeholder rules after marker and batch rules", () => {
    const input = `<span ${HTML_ATTRIBUTE_MARKER}="0">First {{0}}</span>\n\n%%\n\nSecond {{0}}`

    const result = getTranslatePromptFromConfig(defaultTranslatePromptConfig, "French", input, {
      isBatch: true,
    })

    const batchRulesIndex = result.systemPrompt.indexOf("## Multi-paragraph Translation Rules")
    const markerRulesIndex = result.systemPrompt.indexOf("## Protected HTML Marker Rules")
    const placeholderRulesIndex = result.systemPrompt.indexOf("## Protected Placeholder Rules")
    expect(batchRulesIndex).toBeGreaterThan(-1)
    expect(markerRulesIndex).toBeGreaterThan(batchRulesIndex)
    expect(placeholderRulesIndex).toBeGreaterThan(markerRulesIndex)
  })

  it("replaces new subtitle prompt tokens from stored config", async () => {
    mockGetLocalConfig.mockResolvedValue({
      ...DEFAULT_CONFIG,
      videoSubtitles: {
        ...DEFAULT_CONFIG.videoSubtitles,
        customPromptsConfig: {
          promptId: "subtitle-prompt",
          patterns: [
            {
              id: "subtitle-prompt",
              name: "Subtitles",
              systemPrompt:
                "Use {{targetLanguage}} with {{webTitle}}, {{webDescription}}, and {{videoSummary}}",
              prompt:
                "{{input}} => {{targetLanguage}} / {{webTitle}} / {{webDescription}} / {{videoSummary}}",
            },
          ],
        },
      },
    })

    const result = await getSubtitlesTranslatePrompt("Japanese", "Hello world", {
      context: {
        webTitle: "Video Title",
        webDescription: "Video Description",
        videoSummary: "Video Summary",
      },
    })

    expect(result.systemPrompt).toBe(
      "Use Japanese with Video Title, Video Description, and Video Summary",
    )
    expect(result.prompt).toBe(
      "Hello world => Japanese / Video Title / Video Description / Video Summary",
    )
  })

  it("falls back when subtitle prompt context is null or undefined", async () => {
    mockGetLocalConfig.mockResolvedValue(DEFAULT_CONFIG)

    const result = await getSubtitlesTranslatePrompt("Japanese", "Hello world", {
      context: {
        webTitle: null,
        webDescription: undefined,
        videoSummary: undefined,
      },
    })

    expect(result.systemPrompt).toContain("Video title: No title available")
    expect(result.systemPrompt).toContain("Video summary: No summary available")
    expect(result.systemPrompt).not.toContain("Video description:")
  })
})

describe("prompt template substitution", () => {
  type PromptContext = Record<string, string | null | undefined>
  type Values = Record<string, string>

  interface Surface {
    name: string
    /** Token names the builder substitutes, in template order. */
    tokens: readonly string[]
    /** What the builder writes when a context value is missing or blank. */
    fallbacks: Readonly<Record<string, string>>
    build: (
      template: { systemPrompt: string; prompt: string },
      targetLang: string,
      input: string,
      context?: PromptContext,
      glossaryTerms?: readonly MatchedTerm[],
    ) => Promise<TranslatePromptResult>
  }

  // Replacement-pattern syntax a raw `String.prototype.replaceAll` replacement
  // would interpret: whole match, escaped dollar, before/after the match,
  // numbered and named groups.
  const DOLLAR_SEQUENCES = "$& $$ $` $' $1 $<name>"

  const tokenText = (name: string) => `{{${name}}}`

  const surfaces: Surface[] = [
    {
      name: "page and selection",
      tokens: ["targetLanguage", "input", "webTitle", "webDescription", "webContent", "webSummary"],
      fallbacks: {
        webTitle: "No title available",
        webDescription: "No description available",
        webContent: "No content available",
        webSummary: "No summary available",
      },
      // The selection toolbar calls this same builder with the same arguments.
      build: async (template, targetLang, input, context, glossaryTerms) =>
        getTranslatePromptFromConfig(
          {
            customPromptsConfig: {
              promptId: "literal",
              patterns: [{ id: "literal", name: "Literal", ...template }],
            },
          },
          targetLang,
          input,
          {
            ...(context ? { context } : {}),
            ...(glossaryTerms ? { glossaryTerms } : {}),
          },
        ),
    },
    {
      name: "subtitle",
      tokens: ["targetLanguage", "input", "webTitle", "webDescription", "videoSummary"],
      fallbacks: {
        webTitle: "No title available",
        webDescription: "No description available",
        videoSummary: "No summary available",
      },
      build: async (template, targetLang, input, context, glossaryTerms) => {
        mockGetLocalConfig.mockResolvedValue({
          ...DEFAULT_CONFIG,
          videoSubtitles: {
            ...DEFAULT_CONFIG.videoSubtitles,
            customPromptsConfig: {
              promptId: "literal",
              patterns: [{ id: "literal", name: "Literal", ...template }],
            },
          },
        })
        return getSubtitlesTranslatePrompt(targetLang, input, {
          // Pass the matched terms (or none) so no test reaches the real matcher.
          glossaryTerms: glossaryTerms ?? [],
          ...(context ? { context } : {}),
        })
      },
    },
  ]

  /** `name=<token>` for every token, so a wrong substitution names its token. */
  const templateOf = (tokens: readonly string[], repeat = 1) => {
    const body = tokens
      .map((name) => `${name}=${Array.from({ length: repeat }, () => tokenText(name)).join("/")}`)
      .join(" | ")
    return { systemPrompt: `SYS ${body}`, prompt: `USR ${body}` }
  }

  /** The literal text the template must render to, built without any replace call. */
  const expectedOf = (tokens: readonly string[], values: Values, repeat = 1) => {
    const body = tokens
      .map((name) => `${name}=${Array.from({ length: repeat }, () => values[name]).join("/")}`)
      .join(" | ")
    return { systemPrompt: `SYS ${body}`, prompt: `USR ${body}` }
  }

  const contextOf = (tokens: readonly string[], values: Values): PromptContext =>
    Object.fromEntries(
      tokens
        .filter((name) => name !== "targetLanguage" && name !== "input")
        .map((name) => [name, values[name]]),
    )

  beforeEach(async () => {
    vi.clearAllMocks()
    mockGetLocalConfig = vi.mocked((await import("@/utils/config/storage")).getLocalConfig)
  })

  describe.each(surfaces)("$name path", (surface) => {
    const { tokens } = surface
    const contextKeys = tokens.filter((name) => name !== "targetLanguage" && name !== "input")
    const allTokensText = tokens.map(tokenText).join(" ")

    it("keeps dollar replacement sequences literal in every value", async () => {
      const values = Object.fromEntries(tokens.map((name) => [name, `${name} ${DOLLAR_SEQUENCES}`]))

      const result = await surface.build(
        templateOf(tokens),
        values.targetLanguage!,
        values.input!,
        contextOf(tokens, values),
      )

      expect(result).toEqual(expectedOf(tokens, values))
    })

    it("does not re-expand known tokens that are embedded in a value", async () => {
      const values = Object.fromEntries(
        tokens.map((name) => [name, `${name} embeds ${allTokensText}`]),
      )

      const result = await surface.build(
        templateOf(tokens),
        values.targetLanguage!,
        values.input!,
        contextOf(tokens, values),
      )

      expect(result).toEqual(expectedOf(tokens, values))
    })

    it("replaces every occurrence of a repeated token with the same literal value", async () => {
      const values = Object.fromEntries(
        tokens.map((name) => [name, `${name} ${DOLLAR_SEQUENCES} ${allTokensText}`]),
      )

      const result = await surface.build(
        templateOf(tokens, 3),
        values.targetLanguage!,
        values.input!,
        contextOf(tokens, values),
      )

      expect(result).toEqual(expectedOf(tokens, values, 3))
    })

    it.each<[string, ((keys: readonly string[]) => PromptContext) | undefined]>([
      ["no context", undefined],
      ["an empty context", () => ({})],
      ["null values", (keys) => Object.fromEntries(keys.map((name) => [name, null]))],
      ["undefined values", (keys) => Object.fromEntries(keys.map((name) => [name, undefined]))],
      ["empty strings", (keys) => Object.fromEntries(keys.map((name) => [name, ""]))],
      [
        "whitespace-only strings",
        (keys) => Object.fromEntries(keys.map((name) => [name, " \n\t "])),
      ],
    ])("writes the fallback for every missing value with %s", async (_case, makeContext) => {
      const values: Values = { targetLanguage: "English", input: "Hello", ...surface.fallbacks }

      const result = await surface.build(
        templateOf(tokens),
        "English",
        "Hello",
        makeContext?.(contextKeys),
      )

      expect(result).toEqual(expectedOf(tokens, values))
    })

    it("falls back only for the missing value when the rest of the context is present", async () => {
      const provided = contextKeys.slice(1)
      const values: Values = {
        targetLanguage: "English",
        input: "Hello",
        ...surface.fallbacks,
        ...Object.fromEntries(provided.map((name) => [name, `${name} ${DOLLAR_SEQUENCES}`])),
      }

      const result = await surface.build(
        templateOf(tokens),
        "English",
        "Hello",
        Object.fromEntries(provided.map((name) => [name, values[name]])),
      )

      expect(result).toEqual(expectedOf(tokens, values))
    })

    it("does not fill a missing value's token that appears inside another value", async () => {
      // `{{webTitle}}` typed in the page text must stay as typed even though the
      // title is missing and would otherwise render its fallback.
      const values: Values = {
        targetLanguage: "English",
        input: `Quote: ${allTokensText}`,
        ...surface.fallbacks,
      }

      const result = await surface.build(templateOf(tokens), "English", values.input!, {})

      expect(result).toEqual(expectedOf(tokens, values))
      expect(result.prompt).toContain(`input=Quote: ${allTokensText} |`)
    })

    it("leaves unknown, legacy and malformed tokens exactly as written", async () => {
      // The tokens another surface substitutes are unknown to this one.
      const foreign = ["webContent", "webSummary", "videoSummary"]
        .filter((name) => !tokens.includes(name))
        .map(tokenText)
      const unknown = [
        ...foreign,
        "{{targetLang}}",
        "{{title}}",
        "{{ input }}",
        "{{NO_TRANSLATION_NEEDED}}",
        "{{}}",
        "{{input",
      ].join(" ")
      // `{{0}}` is left out of the input on purpose: an inline-atom placeholder
      // there appends the placeholder rules to the page system prompt.
      const templateOnly = "{{0}}"

      const result = await surface.build(
        {
          systemPrompt: `SYS ${unknown} ${templateOnly} {{{input}}}`,
          prompt: `USR ${unknown} ${templateOnly} {{input}}`,
        },
        "English",
        `Hello ${unknown}`,
        {},
      )

      expect(result).toEqual({
        systemPrompt: `SYS ${unknown} ${templateOnly} {Hello ${unknown}}`,
        prompt: `USR ${unknown} ${templateOnly} Hello ${unknown}`,
      })
    })

    it("appends the glossary block after substitution without expanding it", async () => {
      const terms: MatchedTerm[] = [
        {
          matchKey: "a",
          source: "{{input}}",
          target: `${DOLLAR_SEQUENCES} {{webTitle}}`,
          keepOriginal: false,
        },
        { matchKey: "b", source: "$&", target: "", keepOriginal: true },
      ]
      // Plain input: this case pins glossary composition alone; hostile input is
      // covered above.
      const values: Values = { targetLanguage: "English", input: "Hello", ...surface.fallbacks }

      const result = await surface.build(templateOf(tokens), "English", values.input!, {}, terms)

      expect(result.systemPrompt).toBe(
        appendGlossaryToSystemPrompt(expectedOf(tokens, values).systemPrompt, terms),
      )
      expect(result.systemPrompt).toContain(`{{input}} => ${DOLLAR_SEQUENCES} {{webTitle}}`)
      expect(result.systemPrompt).toContain("$& => KEEP ORIGINAL")
      expect(result.prompt).toBe(expectedOf(tokens, values).prompt)
    })
  })

  it("keeps hostile page text literal in the built-in page templates", () => {
    const input = `Pay $& now ${tokenText("webTitle")} $' ${tokenText("webSummary")}`

    const result = getTranslatePromptFromConfig(defaultTranslatePromptConfig, "Japanese", input, {
      context: { webTitle: "Shop $& $'", webSummary: "Sum $$ {{input}}" },
    })

    expect(result.prompt).toContain(`\n${input}`)
    expect(result.prompt).not.toContain("Shop")
    expect(result.systemPrompt).toContain("Webpage title: Shop $& $'\n")
    expect(result.systemPrompt).toContain("Webpage summary: Sum $$ {{input}}")
  })

  it("keeps hostile subtitle text literal in the built-in subtitle templates", async () => {
    mockGetLocalConfig.mockResolvedValue(DEFAULT_CONFIG)
    const input = `Pay $& now ${tokenText("webTitle")} $' ${tokenText("videoSummary")}`

    const result = await getSubtitlesTranslatePrompt("Japanese", input, {
      glossaryTerms: [],
      context: { webTitle: "Clip $& $'", videoSummary: "Sum $$ {{input}}" },
    })

    expect(result.prompt).toContain(`\n${input}`)
    expect(result.prompt).not.toContain("Clip")
    expect(result.systemPrompt).toContain("Video title: Clip $& $'\n")
    expect(result.systemPrompt).toContain("Video summary: Sum $$ {{input}}")
  })
})

describe("no-translation sentinel", () => {
  const defaultPromptsConfig: Pick<Config["pageTranslation"], "customPromptsConfig"> = {
    customPromptsConfig: { promptId: DEFAULT_TRANSLATE_PROMPT_ID, patterns: [] },
  }

  it.each(["Simplified Chinese", "English", "Japanese"])(
    "appends the sentinel rule to batch prompts with %s substituted",
    (targetLanguage) => {
      const result = getTranslatePromptFromConfig(defaultPromptsConfig, targetLanguage, "Hi", {
        isBatch: true,
      })

      expect(result.systemPrompt).toContain("Already-translated Input Rule")
      expect(result.systemPrompt).toContain(NO_TRANSLATION_SENTINEL)
      expect(result.systemPrompt).toContain(`differ from ${targetLanguage}`)
      expect(result.systemPrompt).not.toContain("{{targetLanguage}}")
    },
  )

  it("keeps the marker out of the batch format example", () => {
    const result = getTranslatePromptFromConfig(defaultPromptsConfig, "Simplified Chinese", "Hi", {
      isBatch: true,
    })

    // A marked slot in the worked example taught models a ~1-in-3 marker base
    // rate that dominated the rule and silently dropped paragraphs. Every
    // example segment must show a real translation.
    expect(result.systemPrompt).toContain("Translation B")
    expect(result.systemPrompt).not.toContain(`${NO_TRANSLATION_SENTINEL}\n\n%%`)
    expect(result.systemPrompt).not.toContain("this one is already written in")
    // The page batch block is byte-identical to the one subtitles use.
    expect(result.systemPrompt).toContain(DEFAULT_BATCH_TRANSLATE_PROMPT)
  })

  it("keeps the selected marker rule small and pins its safety boundary", () => {
    const lines = DEFAULT_SENTINEL_TRANSLATE_PROMPT.split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[1]!.length).toBeLessThan(240)
    expect(DEFAULT_SENTINEL_TRANSLATE_PROMPT).toContain(
      "names, brands, handles, URLs, numbers, or code",
    )
    expect(DEFAULT_SENTINEL_TRANSLATE_PROMPT).toContain(
      "A foreign-language phrase or clause must be translated",
    )
  })

  it("never leaks the sentinel into subtitle prompts, which share the batch rules", async () => {
    mockGetLocalConfig.mockResolvedValue(DEFAULT_CONFIG)

    const result = await getSubtitlesTranslatePrompt("Japanese", "Hello world", {
      isBatch: true,
      context: { webTitle: "Video", webDescription: "Desc", videoSummary: "Sum" },
    })

    // isBatch is what appends the shared batch block — assert it actually
    // arrived, or the marker check below passes vacuously.
    expect(result.systemPrompt).toContain(DEFAULT_BATCH_TRANSLATE_PROMPT)
    // The subtitle pipeline has no sentinel mapping; the marker must never
    // appear in its prompts (rule or example).
    expect(result.systemPrompt).not.toContain(NO_TRANSLATION_SENTINEL)
    expect(result.systemPrompt).not.toContain("Already-translated Input Rule")
  })

  it("appends the sentinel rule after a custom system prompt in batch mode", () => {
    const config: Pick<Config["pageTranslation"], "customPromptsConfig"> = {
      customPromptsConfig: {
        promptId: "custom",
        patterns: [
          { id: "custom", name: "Custom", systemPrompt: "My prompt", prompt: "{{input}}" },
        ],
      },
    }

    const result = getTranslatePromptFromConfig(config, "English", "Hi", { isBatch: true })

    expect(result.systemPrompt).toContain("My prompt")
    expect(result.systemPrompt).toContain(NO_TRANSLATION_SENTINEL)
  })

  it("does not add the sentinel rule to non-batch prompts", () => {
    const result = getTranslatePromptFromConfig(defaultPromptsConfig, "English", "Hi")

    expect(result.systemPrompt).not.toContain(NO_TRANSLATION_SENTINEL)
  })

  it("matches only a full trimmed sentinel segment", () => {
    expect(isNoTranslationSentinel(NO_TRANSLATION_SENTINEL)).toBe(true)
    expect(isNoTranslationSentinel(`  ${NO_TRANSLATION_SENTINEL}\n`)).toBe(true)
    expect(isNoTranslationSentinel(`text ${NO_TRANSLATION_SENTINEL}`)).toBe(false)
    expect(isNoTranslationSentinel("{{NO_TRANSLATION")).toBe(false)
    expect(isNoTranslationSentinel("")).toBe(false)
  })
})
