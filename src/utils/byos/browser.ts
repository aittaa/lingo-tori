export function isByosExtensionProtocol(protocol: string) {
  return protocol === "chrome-extension:" || protocol === "moz-extension:"
}

export function isByosExtensionUrl(value: string) {
  try {
    const url = new URL(value)
    return isByosExtensionProtocol(url.protocol) && !!url.hostname
  } catch {
    return false
  }
}

export function isByosConnectionRefused(error: string, protocol: string) {
  if (protocol === "chrome-extension:") return error === "net::ERR_CONNECTION_REFUSED"
  // Firefox WebNavigation emits `Error code ${status}`. NS_ERROR_CONNECTION_REFUSED
  // is 0x804b000d (2152398861). Reject every other error, including security warnings.
  return protocol === "moz-extension:" && error === "Error code 2152398861"
}
