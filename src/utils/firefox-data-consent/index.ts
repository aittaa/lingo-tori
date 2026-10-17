export { createConsentGatedFetch } from "./gated-fetch"
export type { ConsentGatedFetchOptions } from "./gated-fetch"
export {
  headersCarryCredentials,
  optionsCarryCredentials,
  providerConfigCarriesCredentials,
  requestCarriesCredentials,
  urlCarriesCredentials,
} from "./credentials"
export type { ProviderCredentialSource } from "./credentials"
export {
  DATA_CONSENT_CATEGORIES,
  DATA_CONSENT_REQUIRED_ERROR_NAME,
  DataConsentRequiredError,
  findDataConsentError,
  isDataConsentRequiredError,
} from "./errors"
export type { DataConsentCategory, DataConsentRefusalReason } from "./errors"
export {
  assertDataConsent,
  getDataConsentStatus,
  isDataConsentBuild,
  requestDataConsent,
  watchDataConsent,
} from "./status"
export type { DataConsentStatus } from "./status"
