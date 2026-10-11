import type { PlatformConfig } from "@/entrypoints/subtitles.content/platforms"
import type { Config } from "@/types/config/config"
import type { PromptableProviderRef } from "@/utils/providers/provider-ref"
import type { SubtitlesFetcher } from "@/utils/subtitles/fetchers/types"
import type { SubtitlesVideoContext } from "@/utils/subtitles/processor/translator"
import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { getLocalConfig } from "@/utils/config/storage"
import {
  MAX_GAP_MS,
  PROCESS_LOOK_AHEAD_MS,
  TRANSLATION_BATCH_SIZE,
} from "@/utils/constants/subtitles"
import { getSourceDocumentTitle } from "@/utils/content/document-title"
import { resolveLanguageCodeFromLocale } from "@/utils/content/page-language"
import { i18n } from "@/utils/i18n"
import { canProviderRefGenerateText } from "@/utils/providers/provider-ref"
import { aiSegmentBlock } from "@/utils/subtitles/processor/ai-segmentation"
import { optimizeSubtitles } from "@/utils/subtitles/processor/optimizer"
import {
  buildSubtitlesSummaryContextHash,
  resolveSubtitlesProviderRef,
  fetchSubtitlesSummary,
  translateSubtitles,
} from "@/utils/subtitles/processor/translator"
import { buildSubtitlesSrtContent } from "@/utils/subtitles/srt"
import { subtitlesStore, SubtitleCopyPhase, translatedSubtitlesCopyStatusAtom } from "./atoms"
import { SubtitleClipboardExporter } from "./subtitle-clipboard-exporter"

const MAX_COLLAPSED_AI_SEGMENT_DURATION_MS = 1
const TRANSLATED_EXPORT_BATCH_CONCURRENCY = 2

export class TranslatedSubtitlesExporter {
  private operationId = 0
  private snapshotFetcher: SubtitlesFetcher | null = null
  private clipboard: SubtitleClipboardExporter

  constructor(
    private getFetcher: () => SubtitlesFetcher,
    config: PlatformConfig,
    getContext: () => unknown = () => config.getVideoId?.(),
  ) {
    this.clipboard = new SubtitleClipboardExporter(
      (assertActive) => this.prepare(assertActive),
      (status) => subtitlesStore.set(translatedSubtitlesCopyStatusAtom, status),
      getContext,
    )
  }

  copy = (): Promise<void> => this.clipboard.run()

  private get fetcher(): SubtitlesFetcher {
    return this.snapshotFetcher ?? this.getFetcher()
  }

  private async prepare(assertActive: () => void): Promise<string> {
    this.snapshotFetcher = this.getFetcher()
    const operationId = ++this.operationId
    const pageTitle = getSourceDocumentTitle()
    try {
      const configSnapshot = await getLocalConfig()
      assertActive()
      this.assertActive(operationId)
      if (!configSnapshot) throw new Error(i18n.t("subtitles.errors.translatedExportFailed"))
      const sourceSubtitles = await this.fetcher.fetch()
      assertActive()
      this.assertActive(operationId)
      if (sourceSubtitles.length === 0) throw new Error(i18n.t("subtitles.errors.noSubtitlesFound"))
      this.assertDifferentTargetLanguage(configSnapshot)
      this.setStatus(SubtitleCopyPhase.Preparing, 0)
      const sourceProcessedSubtitles = this.fetcher.isPreSegmented?.()
        ? [...sourceSubtitles]
        : optimizeSubtitles(sourceSubtitles, this.fetcher.getSourceLanguage())
      const translatedSubtitles = await this.buildCompleteTranslatedSubtitles(
        sourceSubtitles,
        sourceProcessedSubtitles,
        configSnapshot,
        operationId,
        pageTitle,
      )
      assertActive()
      this.assertActive(operationId)
      return buildSubtitlesSrtContent(
        translatedSubtitles.map(({ translation, ...fragment }) => ({
          ...fragment,
          text: translation ?? "",
        })),
      )
    } finally {
      if (operationId === this.operationId) this.snapshotFetcher = null
    }
  }

  dispose(): void {
    this.operationId++
    this.snapshotFetcher = null
    this.clipboard.dispose()
  }

  private setStatus(phase: SubtitleCopyPhase, progress: number | null): void {
    subtitlesStore.set(translatedSubtitlesCopyStatusAtom, { phase, progress })
  }

  private isActive(operationId: number): boolean {
    return operationId === this.operationId && this.snapshotFetcher === this.getFetcher()
  }

  private assertActive(operationId: number): void {
    if (!this.isActive(operationId)) {
      throw new Error("Translated subtitle export was disposed")
    }
  }

  private assertDifferentTargetLanguage(config: Config): void {
    const targetLanguage = config.language.targetCode
    const sourceLanguage = resolveLanguageCodeFromLocale(this.fetcher.getSourceLanguage())

    if (targetLanguage && sourceLanguage && sourceLanguage === targetLanguage) {
      throw new Error(i18n.t("subtitles.errors.translatedExportSameLanguage"))
    }
  }

  private async buildCompleteTranslatedSubtitles(
    sourceSubtitles: SubtitlesFragment[],
    sourceProcessedSubtitles: SubtitlesFragment[],
    config: Config,
    operationId: number,
    pageTitle: string,
  ): Promise<SubtitlesFragment[]> {
    // One resolve for the whole export: segmentation runs per 60s chunk, and a
    // hosted ref would otherwise pay a hostedAi.status round trip per chunk.
    // The generation tasks (segmentation, summary) get the ref narrowed once
    // here — a translate-only provider exports the rule-based recut without a
    // doomed prompt attempt per chunk.
    const providerRef = await resolveSubtitlesProviderRef(config, "lineTranslation")
    const promptableProviderRef =
      providerRef && canProviderRefGenerateText(providerRef) ? providerRef : null
    this.assertActive(operationId)
    const fragments = await this.buildExportProcessedSubtitles(
      sourceSubtitles,
      sourceProcessedSubtitles,
      config,
      operationId,
      promptableProviderRef,
    )
    this.assertActive(operationId)
    const videoContext = await this.buildExportVideoContext(
      sourceSubtitles,
      config,
      operationId,
      pageTitle,
      promptableProviderRef,
    )
    this.assertActive(operationId)
    const translatedFragments: SubtitlesFragment[] = []
    let translatedCount = 0
    const batches = this.buildTranslationBatches(fragments)

    for (let index = 0; index < batches.length; index += TRANSLATED_EXPORT_BATCH_CONCURRENCY) {
      const batchWindow = batches.slice(index, index + TRANSLATED_EXPORT_BATCH_CONCURRENCY)
      const translatedBatchWindow = await Promise.all(
        batchWindow.map(async (batch) => {
          const translatedBatch = await translateSubtitles(batch, videoContext, config)
          this.assertActive(operationId)
          if (
            translatedBatch.length !== batch.length ||
            this.hasIncompleteTranslatedFragments(translatedBatch)
          ) {
            throw new Error(i18n.t("subtitles.errors.translatedExportIncomplete"))
          }

          return translatedBatch
        }),
      )
      this.assertActive(operationId)
      for (const translatedBatch of translatedBatchWindow) {
        translatedFragments.push(...translatedBatch)
        translatedCount += translatedBatch.length
        this.setStatus(
          SubtitleCopyPhase.Translating,
          Math.min(100, Math.round((translatedCount / fragments.length) * 100)),
        )
      }
    }

    if (
      translatedFragments.length !== fragments.length ||
      this.hasIncompleteTranslatedFragments(translatedFragments)
    ) {
      throw new Error(i18n.t("subtitles.errors.translatedExportIncomplete"))
    }

    return translatedFragments
  }

  private hasIncompleteTranslatedFragments(fragments: SubtitlesFragment[]): boolean {
    return fragments.some((fragment) => !fragment.translation?.trim())
  }

  private buildTranslationBatches(fragments: SubtitlesFragment[]): SubtitlesFragment[][] {
    const batches: SubtitlesFragment[][] = []

    for (let index = 0; index < fragments.length; index += TRANSLATION_BATCH_SIZE) {
      batches.push(fragments.slice(index, index + TRANSLATION_BATCH_SIZE))
    }

    return batches
  }

  private async buildExportProcessedSubtitles(
    sourceSubtitles: SubtitlesFragment[],
    sourceProcessedSubtitles: SubtitlesFragment[],
    config: Config,
    operationId: number,
    providerRef: PromptableProviderRef | null,
  ): Promise<SubtitlesFragment[]> {
    // No ref means AI segmentation cannot run (no provider, no model to
    // prompt, or the hosted tier is unavailable); the export then keeps the
    // same rule-based result the feature-off path produces.
    if (!config.videoSubtitles.aiSegmentation || this.fetcher.isPreSegmented?.() || !providerRef) {
      return [...sourceProcessedSubtitles]
    }

    const result: SubtitlesFragment[] = []

    for (const chunk of this.buildSourceSubtitleChunks(sourceSubtitles)) {
      result.push(...(await this.buildExportProcessedChunk(chunk, providerRef, operationId)))
      this.assertActive(operationId)
    }

    return result.sort((a, b) => a.start - b.start)
  }

  private async buildExportProcessedChunk(
    chunk: SubtitlesFragment[],
    providerRef: PromptableProviderRef,
    operationId: number,
  ): Promise<SubtitlesFragment[]> {
    const sourceLanguage = this.fetcher.getSourceLanguage()
    let segmented: SubtitlesFragment[]

    try {
      segmented = await aiSegmentBlock(chunk, providerRef)
      this.assertActive(operationId)
    } catch {
      return optimizeSubtitles(chunk, sourceLanguage)
    }

    const optimized = optimizeSubtitles(segmented, sourceLanguage)

    if (!this.hasUnsafeSegmentedExportTiming(chunk, segmented, optimized)) {
      return optimized
    }

    const retryChunks = this.buildSourceSubtitleChunks(chunk, PROCESS_LOOK_AHEAD_MS / 2)
    if (retryChunks.length > 1) {
      const retryResult: SubtitlesFragment[] = []

      for (const retryChunk of retryChunks) {
        let retrySegmented: SubtitlesFragment[]

        try {
          retrySegmented = await aiSegmentBlock(retryChunk, providerRef)
          this.assertActive(operationId)
        } catch {
          return optimizeSubtitles(chunk, sourceLanguage)
        }

        const retryOptimized = optimizeSubtitles(retrySegmented, sourceLanguage)

        if (this.hasUnsafeSegmentedExportTiming(retryChunk, retrySegmented, retryOptimized)) {
          return optimizeSubtitles(chunk, sourceLanguage)
        }

        retryResult.push(...retryOptimized)
      }

      return retryResult
    }

    return optimizeSubtitles(chunk, sourceLanguage)
  }

  private hasUnsafeExportTiming(
    source: SubtitlesFragment[],
    candidate: SubtitlesFragment[],
  ): boolean {
    return (
      this.hasInvalidTimingShape(source, candidate) || this.hasTimingCoverageGap(source, candidate)
    )
  }

  private hasUnsafeSegmentedExportTiming(
    source: SubtitlesFragment[],
    segmented: SubtitlesFragment[],
    optimized: SubtitlesFragment[],
  ): boolean {
    return (
      this.hasInvalidTimingShape(source, segmented) || this.hasUnsafeExportTiming(source, optimized)
    )
  }

  private buildSourceSubtitleChunks(
    subtitles: SubtitlesFragment[],
    maxDurationMs = PROCESS_LOOK_AHEAD_MS,
  ): SubtitlesFragment[][] {
    const chunks: SubtitlesFragment[][] = []
    let index = 0

    while (index < subtitles.length) {
      const chunkStart = subtitles[index]!.start
      const chunkEnd = chunkStart + maxDurationMs
      const chunk: SubtitlesFragment[] = []

      while (index < subtitles.length && subtitles[index]!.start < chunkEnd) {
        chunk.push(subtitles[index]!)
        index++
      }

      chunks.push(chunk)
    }

    return chunks
  }

  private hasTimingCoverageGap(
    source: SubtitlesFragment[],
    candidate: SubtitlesFragment[],
  ): boolean {
    const sourceCoverage = this.mergeCoverageIntervals(source)
    const candidateCoverage = this.mergeCoverageIntervals(candidate)

    for (const sourceInterval of sourceCoverage) {
      let coveredUntil = sourceInterval.start

      for (const candidateInterval of candidateCoverage) {
        if (candidateInterval.end <= coveredUntil) {
          continue
        }
        if (candidateInterval.start >= sourceInterval.end) {
          break
        }

        const overlapStart = Math.max(candidateInterval.start, sourceInterval.start)
        if (overlapStart - coveredUntil > MAX_GAP_MS) {
          return true
        }

        coveredUntil = Math.max(coveredUntil, Math.min(candidateInterval.end, sourceInterval.end))
      }

      if (sourceInterval.end - coveredUntil > MAX_GAP_MS) {
        return true
      }
    }

    return false
  }

  private hasInvalidTimingShape(
    source: SubtitlesFragment[],
    candidate: SubtitlesFragment[],
  ): boolean {
    if (source.length === 0 || candidate.length === 0) {
      return true
    }

    const sourceStart = Math.min(...source.map((fragment) => fragment.start))
    const sourceEnd = Math.max(...source.map((fragment) => fragment.end))
    const sortedCandidates = [...candidate].sort((a, b) => a.start - b.start || a.end - b.end)

    for (let index = 0; index < sortedCandidates.length; index++) {
      const fragment = sortedCandidates[index]
      if (
        !Number.isFinite(fragment!.start) ||
        !Number.isFinite(fragment!.end) ||
        fragment!.end - fragment!.start <= MAX_COLLAPSED_AI_SEGMENT_DURATION_MS ||
        fragment!.start < sourceStart ||
        fragment!.end > sourceEnd
      ) {
        return true
      }

      const previous = sortedCandidates[index - 1]
      if (previous && previous.end > fragment!.start) {
        return true
      }
    }

    return false
  }

  private mergeCoverageIntervals(
    fragments: SubtitlesFragment[],
  ): Array<{ start: number; end: number }> {
    const intervals = fragments
      .filter((fragment) => fragment.end > fragment.start)
      .map((fragment) => ({ start: fragment.start, end: fragment.end }))
      .sort((a, b) => a.start - b.start)

    const merged: Array<{ start: number; end: number }> = []

    for (const interval of intervals) {
      const previous = merged.at(-1)
      if (previous && interval.start - previous.end <= MAX_GAP_MS) {
        previous.end = Math.max(previous.end, interval.end)
      } else {
        merged.push({ ...interval })
      }
    }

    return merged
  }

  private async buildExportVideoContext(
    sourceSubtitles: SubtitlesFragment[],
    config: Config,
    operationId: number,
    pageTitle: string,
    providerRef: PromptableProviderRef | null,
  ): Promise<SubtitlesVideoContext> {
    const videoContext: SubtitlesVideoContext = {
      videoTitle: pageTitle,
      subtitlesTextContent: sourceSubtitles.map((fragment) => fragment.text).join(""),
    }
    const summaryContextHash = buildSubtitlesSummaryContextHash(
      videoContext,
      providerRef ?? undefined,
    )

    if (summaryContextHash) {
      try {
        videoContext.summary = await fetchSubtitlesSummary(videoContext, config, providerRef)
        this.assertActive(operationId)
      } catch {
        videoContext.summary = null
      }
    }

    return videoContext
  }
}
