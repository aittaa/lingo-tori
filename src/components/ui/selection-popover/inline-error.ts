import type { ErrorAction } from "@/utils/error-action"
import { browser } from "#imports"
import { StreamPortError } from "@/utils/content-script/port-streaming"
import { isExtensionContextInvalidatedError } from "@/utils/error/extension-context"
import { extractAISDKErrorMessage } from "@/utils/error/extract-message"
import { i18n } from "@/utils/i18n"
import { buildFeatureProviderRoute } from "@/utils/navigation"

export interface SelectionToolbarInlineError {
  title: string
  description: string
  action?: ErrorAction
}

type SelectionToolbarErrorKind = "translate" | "customAction"
type SelectionToolbarPrecheckErrorCode =
  | "actionUnavailable"
  | "missingSelection"
  | "providerDisabled"
  | "providerUnavailable"

const UNEXPECTED_ERROR_MESSAGE = "Unexpected error occurred"

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

function getErrorTitle(kind: SelectionToolbarErrorKind) {
  return kind === "translate"
    ? i18n.t("translation.failed")
    : i18n.t("options.selectionToolbar.errors.customActionFailed")
}

function getErrorFallbackDescription(kind: SelectionToolbarErrorKind) {
  return kind === "translate"
    ? i18n.t("translation.failedFallback")
    : i18n.t("options.selectionToolbar.errors.customActionFailedFallback")
}

function getPrecheckErrorDescription(code: SelectionToolbarPrecheckErrorCode) {
  return i18n.t(`options.selectionToolbar.errors.${code}` as never)
}

function toErrorDescription(kind: SelectionToolbarErrorKind, error: unknown) {
  // Raw "Extension context invalidated." tells the user nothing actionable, and
  // the popover's retry button can never recover from it — only a reload can.
  if (isExtensionContextInvalidatedError(error)) {
    return i18n.t("translation.extensionContextInvalidated")
  }

  const message = extractAISDKErrorMessage(error)
  if (!message || message === UNEXPECTED_ERROR_MESSAGE) {
    return getErrorFallbackDescription(kind)
  }

  return message
}

export function createSelectionToolbarPrecheckError(
  kind: SelectionToolbarErrorKind,
  code: SelectionToolbarPrecheckErrorCode,
): SelectionToolbarInlineError {
  return {
    title: getErrorTitle(kind),
    description: getPrecheckErrorDescription(code),
  }
}

/**
 * The feature has no usable provider, so the popover cannot even try. Unlike the other precheck
 * errors this one carries the way out: a link to the feature's own row in Feature providers
 * (`rowId`, from getFeatureProviderRowId / getCustomActionProviderRowId). It travels as an
 * `action`, so the alert opens it through the background like a stream failure's button — it is
 * never opened on its own.
 */
export function createSelectionToolbarProviderRequiredError(
  kind: SelectionToolbarErrorKind,
  rowId: string,
): SelectionToolbarInlineError {
  return {
    title: getErrorTitle(kind),
    description: i18n.t("providerRequired.message"),
    action: {
      label: i18n.t("providerRequired.openSettings"),
      url: browser.runtime.getURL(`/options.html#${buildFeatureProviderRoute(rowId)}`),
    },
  }
}

export function createSelectionToolbarRuntimeError(
  kind: SelectionToolbarErrorKind,
  error: unknown,
): SelectionToolbarInlineError {
  return {
    title: getErrorTitle(kind),
    description: toErrorDescription(kind, error),
    action: error instanceof StreamPortError ? error.action : undefined,
  }
}
