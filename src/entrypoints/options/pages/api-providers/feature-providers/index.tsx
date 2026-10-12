import type { ReactNode } from "react"
import type { ProviderConfig } from "@/types/config/provider"
import type { SelectionToolbarCustomAction } from "@/types/config/selection-toolbar"
import type { FeatureKey } from "@/utils/constants/feature-providers"
import { useEffect } from "react"
import { useLocation } from "react-router"
import ProviderSelector from "@/components/llm-providers/provider-selector"
import { SetApiKeyWarning } from "@/components/llm-providers/set-api-key-warning"
import {
  useCustomActionProviders,
  useFeatureProvider,
} from "@/components/llm-providers/use-feature-providers"
import {
  FEATURE_KEYS,
  getFeatureDescriptionI18nKey,
  getFeatureLabelI18nKey,
} from "@/utils/constants/feature-providers"
import { i18n } from "@/utils/i18n"
import {
  getCustomActionProviderRowId,
  getFeatureProviderRowId,
  isFeatureProviderRowId,
} from "@/utils/navigation"
import { getSectionIdFromSearch } from "../../../command-palette/section-scroll"
import { ConfigItem } from "../../../components/config-item"
import { ConfigSection } from "../../../components/config-section"
import { SELECT_CONTENT_PROPS } from "../../../components/select-content-props"

/** How much of a custom action's system prompt stands in for a description before it is cut. */
const SYSTEM_PROMPT_PREVIEW_WORDS = 8
/** Backstop for text the segmenter finds no word breaks in, and the budget when it is missing. */
const SYSTEM_PROMPT_PREVIEW_CHARS = 160
/** Separators left at the cut would sit awkwardly in front of the ellipsis. */
const TRAILING_SEPARATORS_RE = /[\s\p{P}]+$/u

/**
 * How far into `text` the preview may run, capped in words rather than characters: 80 characters
 * of Chinese carries several times the content of 80 characters of English, so a character budget
 * leaves previews wildly uneven between languages. The prompt's own language is unknown, so the
 * segmenter runs on the default locale — CJK is segmented from a dictionary either way.
 */
function findPreviewEnd(text: string): number {
  const capped = Math.min(text.length, SYSTEM_PROMPT_PREVIEW_CHARS)
  // Firefox only grew Intl.Segmenter in 125, well past the 112 this extension still supports.
  if (typeof Intl.Segmenter !== "function") return capped

  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" })
  let words = 0
  for (const { index, isWordLike } of segmenter.segment(text)) {
    if (!isWordLike) continue
    words += 1
    if (words > SYSTEM_PROMPT_PREVIEW_WORDS) return Math.min(index, capped)
  }
  return capped
}

/**
 * Custom actions carry no description of their own, so the head of their system prompt stands
 * in for one. Newlines and markdown headings are collapsed to keep it to a single line.
 */
export function toSystemPromptPreview(action: SelectionToolbarCustomAction): string {
  const singleLine = (action.systemPrompt.trim() || action.prompt).replace(/\s+/g, " ").trim()
  const end = findPreviewEnd(singleLine)
  if (end >= singleLine.length) {
    return singleLine
  }
  return `${singleLine.slice(0, end).replace(TRAILING_SEPARATORS_RE, "")}…`
}

function FeatureProviderTitle({
  children,
  providerConfig,
}: {
  children: ReactNode
  providerConfig: ProviderConfig | null
}) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      {children}
      <SetApiKeyWarning providerConfig={providerConfig} />
    </span>
  )
}

/**
 * A "choose a provider" link names one feature's row through `?section=`. The scroll lands on
 * that row; this also puts the keyboard on its selector. Other section links only scroll.
 */
function useFocusRequestedSelector() {
  const { search } = useLocation()

  useEffect(() => {
    const sectionId = getSectionIdFromSearch(search)
    if (!sectionId || !isFeatureProviderRowId(sectionId)) return

    const row = document.getElementById(sectionId)
    const selector = row?.querySelector<HTMLElement>('[role="combobox"]')
    if (selector && !selector.matches(':disabled, [aria-disabled="true"]')) {
      selector.focus({ preventScroll: true })
      return
    }

    // No compatible providers leaves the native selector disabled. Focus its title
    // so keyboard users still arrive at the requested setting without opening a picker.
    const title = row?.querySelector<HTMLElement>("h3")
    if (title) {
      title.tabIndex = -1
      title.focus({ preventScroll: true })
    }
  }, [search])
}

function FeatureProviderItem({ featureKey }: { featureKey: FeatureKey }) {
  const { providers, providerId, providerConfig, setProviderId } = useFeatureProvider(featureKey)

  return (
    <ConfigItem
      id={getFeatureProviderRowId(featureKey)}
      title={
        <FeatureProviderTitle providerConfig={providerConfig}>
          {i18n.t(getFeatureLabelI18nKey(featureKey))}
        </FeatureProviderTitle>
      }
      description={i18n.t(getFeatureDescriptionI18nKey(featureKey))}
    >
      <ProviderSelector
        providers={providers}
        value={providerId}
        onChange={setProviderId}
        triggerSize="sm"
        selectContentProps={SELECT_CONTENT_PROPS}
      />
    </ConfigItem>
  )
}

function CustomActionProviderItems() {
  const { actions, providers, getProviderConfig, setActionProviderId } = useCustomActionProviders()

  return actions.map((action) => (
    <ConfigItem
      key={action.id}
      id={getCustomActionProviderRowId(action.id)}
      title={
        <FeatureProviderTitle providerConfig={getProviderConfig(action)}>
          {action.name}
        </FeatureProviderTitle>
      }
      description={toSystemPromptPreview(action)}
    >
      <ProviderSelector
        providers={providers}
        value={action.providerId}
        onChange={(id) => setActionProviderId(action.id, id)}
        triggerSize="sm"
        selectContentProps={SELECT_CONTENT_PROPS}
        placeholder={i18n.t("options.selectionToolbar.customActions.form.selectProvider")}
      />
    </ConfigItem>
  ))
}

export function FeatureProvidersConfig() {
  useFocusRequestedSelector()

  return (
    <ConfigSection
      id="feature-providers"
      title={i18n.t("options.apiProviders.featureProviders.title")}
    >
      {FEATURE_KEYS.map((featureKey) => (
        <FeatureProviderItem key={featureKey} featureKey={featureKey} />
      ))}
      <CustomActionProviderItems />
    </ConfigSection>
  )
}
