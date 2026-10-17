// @vitest-environment jsdom
//
// The settings UI for Firefox's data consent. A row shows where one optional category stands and
// asks for it with a button; the request starts in the click handler, before anything else runs, so
// the user gesture is still live. Nothing shows on a Chrome build. The provider form gets a
// declaration checkbox ("this endpoint URL or its options contain a secret") and, once the provider
// has something secret to send, the credentials row. The custom action editor gets the page-address
// row when a template uses the page URL.
//
// i18n returns the key under test, so the assertions read keys.

import type { APIProviderConfig } from "@/types/config/provider"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DataConsentRow } from "@/components/data-consent/data-consent-row"
import { AutosaveContext, toAutosaveSession } from "@/components/form/use-autosave"
import { EndpointConsentFields } from "@/entrypoints/options/pages/api-providers/providers-config/provider-config-form/endpoint-consent-fields"
import { useProviderForm } from "@/entrypoints/options/pages/api-providers/providers-config/provider-editor"
import { DEFAULT_PROVIDER_CONFIG } from "@/utils/constants/providers"
import {
  installChrome,
  installFirefox,
  KEY_ABSENT,
  NOTHING_GRANTED,
  removePermissionsDouble,
  WITH_CREDENTIALS,
} from "./firefox-permissions"

afterEach(() => {
  cleanup()
  removePermissionsDouble()
})

const DENIED = "dataConsent.status.denied"
const GRANTED = "dataConsent.status.granted"
const UNSUPPORTED = "dataConsent.status.unsupported"
const ALLOW = "dataConsent.allow"

describe("DataConsentRow", () => {
  it("shows a Firefox that has not granted the category, with the button that asks", async () => {
    installFirefox(NOTHING_GRANTED)
    render(<DataConsentRow category="authenticationInfo" />)

    expect(await screen.findByText(DENIED)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: ALLOW })).toBeInTheDocument()
    expect(screen.getByText("dataConsent.authenticationInfo.title")).toBeInTheDocument()
  })

  it("asks Firefox for exactly that category in the click itself, not after an await", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)
    render(<DataConsentRow category="browsingActivity" />)
    const button = await screen.findByRole("button", { name: ALLOW })

    fireEvent.click(button)

    // Checked before any microtask runs: the request started in the gesture's turn.
    expect(permissions.request).toHaveBeenCalledTimes(1)
    expect(permissions.request).toHaveBeenCalledWith({ data_collection: ["browsingActivity"] })
  })

  it("turns to allowed when the user grants, and the button goes away", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)
    permissions.answerPrompts(true)
    render(<DataConsentRow category="authenticationInfo" />)

    fireEvent.click(await screen.findByRole("button", { name: ALLOW }))

    expect(await screen.findByText(GRANTED)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: ALLOW })).not.toBeInTheDocument()
  })

  it("says so when the user declines, and offers the button again", async () => {
    const permissions = installFirefox(NOTHING_GRANTED)
    permissions.answerPrompts(false)
    render(<DataConsentRow category="authenticationInfo" />)

    fireEvent.click(await screen.findByRole("button", { name: ALLOW }))

    expect(await screen.findByRole("alert")).toHaveTextContent("dataConsent.allowFailed")
    expect(screen.getByText(DENIED)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: ALLOW })).toBeInTheDocument()
  })

  it("follows a revocation in about:addons when the window regains focus", async () => {
    const permissions = installFirefox(WITH_CREDENTIALS)
    render(<DataConsentRow category="authenticationInfo" />)
    expect(await screen.findByText(GRANTED)).toBeInTheDocument()

    permissions.report(NOTHING_GRANTED)
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })

    expect(await screen.findByText(DENIED)).toBeInTheDocument()
  })

  it("tells a Firefox without built-in consent that it cannot ask, and offers no button", async () => {
    installFirefox(KEY_ABSENT)
    render(<DataConsentRow category="authenticationInfo" />)

    expect(await screen.findByText(UNSUPPORTED)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: ALLOW })).not.toBeInTheDocument()
  })

  it("renders nothing on a Chrome build, and never asks the browser", async () => {
    const permissions = installChrome()
    const { container } = render(<DataConsentRow category="authenticationInfo" />)

    await act(async () => {})

    expect(container).toBeEmptyDOMElement()
    expect(permissions.browserCalls()).toBe(0)
  })
})

function Harness({
  providerConfig,
  onSave,
}: {
  providerConfig: APIProviderConfig
  onSave?: (changes: Partial<APIProviderConfig>) => void
}) {
  const { form, autosave } = useProviderForm(providerConfig, async (_saved, changes) => {
    onSave?.(changes)
  })
  return (
    <AutosaveContext value={toAutosaveSession(autosave)}>
      <EndpointConsentFields form={form} />
    </AutosaveContext>
  )
}

const OPENAI_COMPATIBLE = DEFAULT_PROVIDER_CONFIG["openai-compatible"]
const DECLARATION = "dataConsent.endpointNeedsConsent.label"
const CREDENTIALS_ROW = "dataConsent.authenticationInfo.title"

describe("the provider form on Firefox", () => {
  it("offers the declaration, off by default, and saves it when ticked", async () => {
    installFirefox(NOTHING_GRANTED)
    const onSave = vi.fn<(changes: Partial<APIProviderConfig>) => void>()
    render(<Harness providerConfig={OPENAI_COMPATIBLE} onSave={onSave} />)

    const checkbox = await screen.findByRole("checkbox", { name: DECLARATION })
    expect(checkbox).not.toBeChecked()

    fireEvent.click(checkbox)

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls.at(-1)![0]).toMatchObject({ endpointNeedsConsent: true })
  })

  it("shows the credentials row once the provider has a key, and not before", async () => {
    installFirefox(NOTHING_GRANTED)
    const keyless = render(<Harness providerConfig={OPENAI_COMPATIBLE} />)
    await screen.findByRole("checkbox", { name: DECLARATION })
    expect(screen.queryByText(CREDENTIALS_ROW)).not.toBeInTheDocument()
    keyless.unmount()

    render(<Harness providerConfig={{ ...OPENAI_COMPATIBLE, apiKey: "sk-test-123" }} />)

    expect(await screen.findByText(CREDENTIALS_ROW)).toBeInTheDocument()
  })

  it("shows the credentials row for a declared endpoint, and for DeepL, which always sends its key", async () => {
    installFirefox(NOTHING_GRANTED)
    const declared = render(
      <Harness providerConfig={{ ...OPENAI_COMPATIBLE, endpointNeedsConsent: true }} />,
    )
    expect(await screen.findByText(CREDENTIALS_ROW)).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: DECLARATION })).toBeChecked()
    declared.unmount()

    render(<Harness providerConfig={DEFAULT_PROVIDER_CONFIG.deepl} />)

    expect(await screen.findByText(CREDENTIALS_ROW)).toBeInTheDocument()
    // DeepL has no endpoint URL to declare anything about.
    expect(screen.queryByRole("checkbox", { name: DECLARATION })).not.toBeInTheDocument()
  })

  it("shows nothing at all on a Chrome build", async () => {
    installChrome()
    const { container } = render(
      <Harness providerConfig={{ ...OPENAI_COMPATIBLE, apiKey: "sk-test-123" }} />,
    )

    await act(async () => {})

    expect(container).toBeEmptyDOMElement()
  })
})
