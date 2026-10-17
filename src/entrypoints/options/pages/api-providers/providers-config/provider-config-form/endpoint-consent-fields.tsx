import type { APIProviderConfig } from "@/types/config/provider"
import { useSelector } from "@tanstack/react-store"
import { DataConsentRow } from "@/components/data-consent/data-consent-row"
import { useAutosaveContext } from "@/components/form/use-autosave"
import { Checkbox } from "@/components/ui/base-ui/checkbox"
import { isLLMProvider } from "@/types/config/provider"
import { isDataConsentBuild, providerConfigCarriesCredentials } from "@/utils/firefox-data-consent"
import { i18n } from "@/utils/i18n"
import { getProviderHeadersWithOverride } from "@/utils/providers/headers"
import { withForm } from "./form"

/**
 * Firefox's data consent for a provider, shown on a Firefox build only:
 * - the user's declaration that the endpoint URL or its options contain a secret the extension
 *   cannot recognise (a key in the path, say). A request to such an endpoint is treated like one
 *   with an API key;
 * - where the grant for sending credentials stands, with the button that asks, once this provider
 *   has a credential to send.
 */
export const EndpointConsentFields = withForm({
  ...{ defaultValues: {} as APIProviderConfig },
  render: function Render({ form }) {
    const autosave = useAutosaveContext()
    const providerConfig = useSelector(form.store, (state) => state.values)
    if (!isDataConsentBuild()) return null

    const provider = providerConfig.provider
    const hasEndpoint = provider !== "deepl"
    const headers = isLLMProvider(provider)
      ? getProviderHeadersWithOverride(provider, providerConfig.headers)
      : undefined
    // DeepL sends its key with every request, even before one is typed in.
    const sendsCredentials =
      provider === "deepl" || providerConfigCarriesCredentials(providerConfig, headers)

    return (
      <>
        {hasEndpoint && (
          <form.AppField name="endpointNeedsConsent">
            {(field) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id={`endpointNeedsConsent-${providerConfig.id}`}
                    checked={field.state.value === true}
                    onCheckedChange={(checked) =>
                      autosave.edit(() => field.handleChange(checked ? true : undefined), {
                        immediate: true,
                      })
                    }
                  />
                  <label
                    htmlFor={`endpointNeedsConsent-${providerConfig.id}`}
                    className="text-sm leading-none font-medium"
                  >
                    {i18n.t("dataConsent.endpointNeedsConsent.label")}
                  </label>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {i18n.t("dataConsent.endpointNeedsConsent.hint")}
                </p>
              </div>
            )}
          </form.AppField>
        )}
        {sendsCredentials && <DataConsentRow category="authenticationInfo" />}
      </>
    )
  },
})
