// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TranslationCard } from "@/entrypoints/translation-hub/components/translation-card"

const {
  anchoredToastAddMock,
  clipboardWriteMock,
  languageAtom,
  glossaryAtom,
  providersAtom,
  requestAtom,
  selectedProviderIdsAtom,
  streamBackgroundTextMock,
  executeTranslateMock,
  ttsAtom,
  ttsPlayMock,
  ttsStopMock,
  providerRefState,
  mutationFnState,
} = vi.hoisted(() => ({
  anchoredToastAddMock: vi.fn<(options: unknown) => void>(),
  clipboardWriteMock: vi.fn<(text: string) => void>(),
  languageAtom: {},
  glossaryAtom: {},
  providersAtom: {},
  requestAtom: {},
  selectedProviderIdsAtom: {},
  streamBackgroundTextMock: vi.fn<(...args: unknown[]) => Promise<{ output: string }>>(),
  executeTranslateMock: vi.fn<(...args: unknown[]) => Promise<string>>(),
  ttsAtom: {},
  ttsPlayMock: vi.fn<(text: string, config: object) => Promise<void>>(),
  ttsStopMock: vi.fn<() => void>(),
  providerRefState: { kind: "local" },
  mutationFnState: { current: null as null | ((request: unknown) => Promise<string | undefined>) },
}))

const ttsState = vi.hoisted(() => ({ isFetching: false, isPlaying: false }))
const ttsConfig = vi.hoisted(() => ({ defaultVoice: "en-US-AriaNeural" }))

interface UseMutationMockShape {
  data: string | undefined
  isError: boolean
  isPending: boolean
  mutate: (request: unknown) => void
  error: Error | undefined
}

const useMutationMock = vi.hoisted(() => {
  const initial: UseMutationMockShape = {
    data: "Translated text",
    isError: false,
    isPending: false,
    mutate: vi.fn<(request: unknown) => void>(),
    error: undefined,
  }
  return { current: initial }
})

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: { mutationFn: (request: unknown) => Promise<string | undefined> }) => {
    mutationFnState.current = options.mutationFn
    return useMutationMock.current
  },
}))

vi.mock("jotai", () => ({
  useAtom: () => [["provider-1"], vi.fn<(value: unknown) => void>()],
  useAtomValue: (atom: object) => {
    if (atom === requestAtom) return null
    if (atom === languageAtom) return { level: "intermediate" }
    if (atom === glossaryAtom) return { enabled: false }
    if (atom === ttsAtom) return ttsConfig
    if (atom === providersAtom) return []
    return undefined
  },
  useSetAtom: () => vi.fn<(value: unknown) => void>(),
}))

vi.mock("@/components/provider-icon", () => ({
  default: () => <span>Provider icon</span>,
}))

vi.mock("@/components/providers/theme-provider", () => ({
  useTheme: () => ({ theme: "light" }),
}))

vi.mock("@/components/ui/base-ui/toast", () => ({
  anchoredToastManager: { add: anchoredToastAddMock },
}))

vi.mock("@/hooks/use-text-to-speech", () => ({
  useTextToSpeech: () => ({
    play: ttsPlayMock,
    stop: ttsStopMock,
    ...ttsState,
  }),
}))

vi.mock("@/utils/atoms/config", () => ({
  configFieldsAtomMap: {
    language: languageAtom,
    glossary: glossaryAtom,
    tts: ttsAtom,
    providersConfig: providersAtom,
  },
}))

describe("TranslationCard speech", () => {
  beforeEach(() => {
    ttsPlayMock.mockReset().mockResolvedValue(undefined)
    ttsStopMock.mockReset()
    ttsState.isFetching = false
    ttsState.isPlaying = false
    useMutationMock.current = {
      data: "Translated text",
      isError: false,
      isPending: false,
      mutate: vi.fn<(request: unknown) => void>(),
      error: undefined,
    }
  })

  it("retains copy and retry without speech controls", () => {
    render(
      <TranslationCard
        providerId="provider-1"
        isExpanded
        onExpandedChange={vi.fn<(expanded: boolean) => void>()}
      />,
    )
    expect(
      screen.getByRole("button", { name: "translationHub.copyTranslation" }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "translationHub.retryTranslation" }),
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "translationHub.speakTranslation" })).toBeNull()
    expect(ttsPlayMock).not.toHaveBeenCalled()
  })

  it("hides speech until a translation succeeds", () => {
    useMutationMock.current.data = undefined
    const { rerender } = render(
      <TranslationCard
        providerId="provider-1"
        isExpanded
        onExpandedChange={vi.fn<(expanded: boolean) => void>()}
      />,
    )

    expect(screen.queryByRole("button", { name: "translationHub.speakTranslation" })).toBeNull()

    useMutationMock.current.data = "Translated text"
    useMutationMock.current.isPending = true
    rerender(
      <TranslationCard
        providerId="provider-1"
        isExpanded
        onExpandedChange={vi.fn<(expanded: boolean) => void>()}
      />,
    )

    expect(screen.queryByRole("button", { name: "translationHub.speakTranslation" })).toBeNull()
  })
})

vi.mock("@/utils/config/helpers", () => ({
  getProviderConfigById: () => ({ id: "provider-1", name: "OpenAI", provider: "openai" }),
}))

vi.mock("@/utils/providers/provider-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/providers/provider-registry")>()),
  BUILT_IN_AI_PROVIDER_LOGO: "built-in-logo",
  resolveProviderRefForCapability: () =>
    providerRefState.kind === "system"
      ? null
      : {
          kind: "local",
          id: "provider-1",
          name: "OpenAI",
          config: { id: "provider-1", name: "OpenAI", provider: "openai" },
        },
}))

vi.mock("@/utils/content-script/background-stream-client", () => ({
  streamBackgroundText: streamBackgroundTextMock,
}))

vi.mock("@/utils/host/translate/execute-translate", () => ({
  executeTranslate: executeTranslateMock,
}))

vi.mock("@/utils/glossary/active-matcher", () => ({
  resolveGlossaryTerms: async () => ({ terms: [], revision: 0 }),
}))

vi.mock("@/utils/i18n", () => ({
  i18n: { t: (key: string) => key },
}))

vi.mock("@/entrypoints/translation-hub/atoms", () => ({
  selectedProviderIdsAtom,
  translateRequestAtom: requestAtom,
  translationCardExpandedStateAtom: {},
}))

describe("TranslationCard copy feedback", () => {
  beforeEach(() => {
    providerRefState.kind = "local"
    anchoredToastAddMock.mockReset()
    clipboardWriteMock.mockReset()
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteMock },
    })
    useMutationMock.current = {
      data: "Translated text",
      isError: false,
      isPending: false,
      mutate: vi.fn<(request: unknown) => void>(),
      error: undefined,
    }
  })

  it("anchors provider-specific copy feedback to the copy button", () => {
    render(
      <TranslationCard
        providerId="provider-1"
        isExpanded
        onExpandedChange={vi.fn<(expanded: boolean) => void>()}
      />,
    )

    const copyButton = screen.getByTitle("translationHub.copyTranslation")
    fireEvent.click(copyButton)

    expect(clipboardWriteMock).toHaveBeenCalledWith("Translated text")
    expect(anchoredToastAddMock).toHaveBeenCalledWith({
      data: { tooltipStyle: true },
      id: "translation-copy-provider-1",
      positionerProps: { anchor: copyButton, sideOffset: 6 },
      title: "translationHub.copiedToClipboard",
    })
  })
})

describe("TranslationCard built-in translation", () => {
  beforeEach(() => {
    streamBackgroundTextMock.mockReset()
  })

  it("keeps removed hosted provider ids unresolved", () => {
    providerRefState.kind = "system"
    render(
      <TranslationCard
        providerId="read-frog-free-ai"
        isExpanded
        onExpandedChange={vi.fn<(expanded: boolean) => void>()}
      />,
    )
    expect(streamBackgroundTextMock).not.toHaveBeenCalled()
  })

  it("passes the independent Hub prompt to local LLMs", async () => {
    providerRefState.kind = "local"
    executeTranslateMock.mockResolvedValueOnce("Local result")
    render(
      <TranslationCard
        providerId="provider-1"
        isExpanded
        onExpandedChange={vi.fn<(expanded: boolean) => void>()}
      />,
    )

    await mutationFnState.current!({
      inputText: "Hello",
      sourceLanguage: "eng",
      targetLanguage: "cmn",
      timestamp: 1,
      promptConfig: {
        promptId: "hub-custom",
        patterns: [
          {
            id: "hub-custom",
            name: "Hub custom",
            systemPrompt: "Hub system",
            prompt: "Hub prompt",
          },
        ],
      },
    })

    const resolver = executeTranslateMock.mock.calls[0]?.[3] as (
      language: string,
      input: string,
    ) => Promise<{ systemPrompt: string; prompt: string }>
    await expect(resolver("Chinese", "Hello")).resolves.toMatchObject({
      systemPrompt: "Hub system",
      prompt: "Hub prompt",
    })
  })
})

describe("TranslationCard error display", () => {
  beforeEach(() => {
    providerRefState.kind = "local"
    useMutationMock.current = {
      data: undefined,
      isError: true,
      isPending: false,
      mutate: vi.fn<(request: unknown) => void>(),
      error: new Error(
        "upstream_429_rate_limit_exceeded_for_provider_openai_completions_with_a_very_long_unbroken_token_stream_that_overflows_the_card_boundary",
      ),
    }
  })

  it("renders long unbroken error messages with overflow-wrap so they stay inside the card", () => {
    render(
      <TranslationCard
        providerId="provider-1"
        isExpanded
        onExpandedChange={vi.fn<(expanded: boolean) => void>()}
      />,
    )

    const errorParagraph = screen.getByText(
      "upstream_429_rate_limit_exceeded_for_provider_openai_completions_with_a_very_long_unbroken_token_stream_that_overflows_the_card_boundary",
    )
    // break-words forces long unbreakable runs to wrap instead of overflowing
    expect(errorParagraph.className).toContain("break-words")
    // whitespace-pre-wrap preserves newlines in multi-line provider errors
    expect(errorParagraph.className).toContain("whitespace-pre-wrap")
  })
})
