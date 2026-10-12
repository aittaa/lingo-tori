import { browser } from "wxt/browser"
import { isByosExtensionUrl } from "./browser"

const CALLBACK_PERMISSION = "declarativeNetRequestWithHostAccess"

export function hasByosCallbackPermission(): Promise<boolean> {
  const root = browser.runtime.getURL("/")
  if (!isByosExtensionUrl(root)) return Promise.resolve(false)
  if (new URL(root).protocol === "moz-extension:") {
    // Gecko accepts this non-prompt permission at install time, not as an
    // optional permission. API presence is checked separately by the transport.
    return Promise.resolve(
      browser.runtime.getManifest().permissions?.includes(CALLBACK_PERMISSION) ?? false,
    )
  }
  return browser.permissions.contains({ permissions: [CALLBACK_PERMISSION] })
}

export function requestByosCallbackPermission(): Promise<boolean> {
  const root = browser.runtime.getURL("/")
  if (!isByosExtensionUrl(root)) return Promise.resolve(false)
  if (new URL(root).protocol === "moz-extension:") return hasByosCallbackPermission()
  // Keep Chromium's optional request synchronous with the explicit click.
  return browser.permissions.request({ permissions: [CALLBACK_PERMISSION] })
}
