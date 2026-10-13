// @vitest-environment jsdom
import type { OnboardingStatus } from "@/utils/onboarding/lifecycle"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { MemoryRouter, Route, Routes, useNavigationType } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { storage } from "#imports"
import { configAtom } from "@/utils/atoms/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { ONBOARDING_STORAGE_KEY } from "@/utils/onboarding/lifecycle"
import { OnboardingPage } from ".."
import { OnboardingRootGuard } from "../root-guard"

const { sendMessageMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/message", () => ({ sendMessage: sendMessageMock }))

// The real picker is a popup list; a button that "picks" Japanese is enough to drive the page, and
// it forwards the label/description wiring so the accessible name and description can be asserted.
vi.mock("@/components/language-combobox", () => ({
  LanguageCombobox: ({
    value,
    onValueChange,
    disabled,
    id,
    "aria-labelledby": labelledBy,
    "aria-describedby": describedBy,
  }: {
    value: string
    onValueChange: (value: string) => void
    disabled?: boolean
    id?: string
    "aria-labelledby"?: string
    "aria-describedby"?: string
  }) => (
    <button
      type="button"
      id={id}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      data-value={value}
      onClick={() => onValueChange("jpn")}
    >
      {`picker:${value}`}
    </button>
  ),
}))

const onboardingKey = `local:${ONBOARDING_STORAGE_KEY}` as const
const configKey = `local:${CONFIG_STORAGE_KEY}` as const
const originalUiLanguage = fakeBrowser.i18n.getUILanguage

function setBrowserLanguage(language: string) {
  fakeBrowser.i18n.getUILanguage = () => language
}

async function renderPage(
  status: OnboardingStatus | "absent" | "invalid",
  { targetCode = DEFAULT_CONFIG.language.targetCode } = {},
) {
  if (status === "invalid") await storage.setItem(onboardingKey, { version: 9, status: "later" })
  else if (status !== "absent") await storage.setItem(onboardingKey, { version: 1, status })
  const config = structuredClone(DEFAULT_CONFIG)
  config.language.targetCode = targetCode
  await storage.setItem(configKey, config)
  // Watches the page only: whatever it writes from here on, not the seeding above.
  setItemSpy = spyOnSetItem()

  const store = createStore()
  store.set(configAtom, config)
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/" element={<div>home</div>} />
          <Route path="/preference" element={<div>settings</div>} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  )
}

async function findQuestion() {
  return screen.findByRole("heading", { level: 1, name: "onboarding.title" })
}

const picker = () => screen.getByRole("button", { name: "onboarding.languageLabel" })
const useButton = () => screen.getByRole("button", { name: "onboarding.use" })
const laterButton = () => screen.getByRole("button", { name: "onboarding.later" })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

const spyOnSetItem = () => vi.spyOn(storage, "setItem")
let setItemSpy: ReturnType<typeof spyOnSetItem>

beforeEach(() => {
  sendMessageMock.mockReset()
  setBrowserLanguage("en-US")
})

afterEach(() => {
  fakeBrowser.i18n.getUILanguage = originalUiLanguage
  vi.restoreAllMocks()
  fakeBrowser.reset()
})

describe("OnboardingPage question", () => {
  it("opens on the browser language, with its label, description and hint wired up", async () => {
    setBrowserLanguage("ko-KR")
    await renderPage("pending")

    const heading = await findQuestion()
    await waitFor(() => expect(heading).toHaveFocus())
    expect(picker()).toHaveAttribute("data-value", "kor")
    expect(picker()).toHaveAccessibleDescription("onboarding.description onboarding.suggested")
    expect(screen.getByText("onboarding.suggested")).toBeInTheDocument()
  })

  it("saves nothing until the person confirms", async () => {
    setBrowserLanguage("ko-KR")
    await renderPage("pending")
    await findQuestion()
    await settle()

    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(setItemSpy).not.toHaveBeenCalled()
    expect((await storage.getItem<typeof DEFAULT_CONFIG>(configKey))!.language.targetCode).toBe(
      DEFAULT_CONFIG.language.targetCode,
    )
    expect(await storage.getItem(onboardingKey)).toEqual({ version: 1, status: "pending" })
  })

  it("keeps the current target when the browser language maps to no offered language", async () => {
    setBrowserLanguage("xx-YY")
    await renderPage("pending")
    await findQuestion()

    expect(picker()).toHaveAttribute("data-value", DEFAULT_CONFIG.language.targetCode)
    expect(picker()).toHaveAccessibleDescription("onboarding.description")
    expect(screen.queryByText("onboarding.suggested")).not.toBeInTheDocument()
  })

  it("keeps a target that was already changed instead of suggesting the browser language", async () => {
    setBrowserLanguage("ko-KR")
    await renderPage("pending", { targetCode: "fra" })
    await findQuestion()

    expect(picker()).toHaveAttribute("data-value", "fra")
    expect(screen.queryByText("onboarding.suggested")).not.toBeInTheDocument()
  })

  it("drops the hint once the person picks something else", async () => {
    setBrowserLanguage("ko-KR")
    await renderPage("pending")
    await findQuestion()

    fireEvent.click(picker())

    expect(picker()).toHaveAttribute("data-value", "jpn")
    expect(screen.queryByText("onboarding.suggested")).not.toBeInTheDocument()
  })

  it("asks again after Later, so a deep link to the page resumes it", async () => {
    await renderPage("dismissed")

    expect(await findQuestion()).toBeInTheDocument()
  })

  describe("Use this language", () => {
    it("sends the completion with the chosen language and leaves for the settings root", async () => {
      sendMessageMock.mockResolvedValue({ ok: true, status: "completed" })
      setBrowserLanguage("ko-KR")
      await renderPage("pending")
      await findQuestion()

      fireEvent.click(useButton())

      expect(await screen.findByText("home")).toBeInTheDocument()
      expect(sendMessageMock).toHaveBeenCalledOnce()
      expect(sendMessageMock).toHaveBeenCalledWith("onboardingTransition", {
        event: "complete",
        targetCode: "kor",
      })
      // The background owns every write; the page itself saves neither language nor record.
      expect(setItemSpy).not.toHaveBeenCalled()
    })

    it("sends whichever language was picked last", async () => {
      sendMessageMock.mockResolvedValue({ ok: true, status: "completed" })
      setBrowserLanguage("ko-KR")
      await renderPage("pending")
      await findQuestion()

      fireEvent.click(picker())
      fireEvent.click(useButton())

      await screen.findByText("home")
      expect(sendMessageMock).toHaveBeenCalledWith("onboardingTransition", {
        event: "complete",
        targetCode: "jpn",
      })
    })

    it("leaves quietly when the profile turns out not to be enrolled", async () => {
      sendMessageMock.mockResolvedValue({ ok: false, reason: "not-eligible" })
      await renderPage("pending")
      await findQuestion()

      fireEvent.click(useButton())

      expect(await screen.findByText("home")).toBeInTheDocument()
    })

    it("disables the controls and marks the card busy while saving", async () => {
      const pending = deferred<unknown>()
      sendMessageMock.mockReturnValue(pending.promise)
      await renderPage("pending")
      await findQuestion()
      const card = screen.getByRole("heading", { level: 1 }).closest("[data-slot=card]")!
      expect(card).toHaveAttribute("aria-busy", "false")

      fireEvent.click(useButton())

      const saving = await screen.findByRole("button", { name: "onboarding.saving" })
      expect(saving).toBeDisabled()
      expect(laterButton()).toBeDisabled()
      expect(picker()).toBeDisabled()
      expect(card).toHaveAttribute("aria-busy", "true")

      pending.resolve({ ok: true, status: "completed" })
      expect(await screen.findByText("home")).toBeInTheDocument()
    })

    it("explains a failed language save and lets the person try again", async () => {
      sendMessageMock.mockResolvedValueOnce({ ok: false, reason: "target-save-failed" })
      sendMessageMock.mockResolvedValueOnce({ ok: true, status: "completed" })
      await renderPage("pending")
      await findQuestion()

      fireEvent.click(useButton())

      const alert = await screen.findByRole("alert")
      expect(alert).toHaveTextContent("onboarding.errorTarget")
      expect(screen.queryByText("home")).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "onboarding.retry" })).not.toBeInTheDocument()
      expect(useButton()).toBeEnabled()

      fireEvent.click(useButton())

      expect(await screen.findByText("home")).toBeInTheDocument()
      expect(sendMessageMock).toHaveBeenCalledTimes(2)
      expect(sendMessageMock.mock.calls[1]).toEqual(sendMessageMock.mock.calls[0])
    })

    it("tells a saved language from an unfinished setup and retries only the completion", async () => {
      sendMessageMock.mockResolvedValueOnce({ ok: false, reason: "lifecycle-save-failed" })
      sendMessageMock.mockResolvedValueOnce({ ok: true, status: "completed" })
      setBrowserLanguage("ko-KR")
      await renderPage("pending")
      await findQuestion()

      fireEvent.click(useButton())

      const alert = await screen.findByRole("alert")
      expect(alert).toHaveTextContent("onboarding.errorComplete")
      expect(alert).not.toHaveTextContent("onboarding.errorTarget")
      fireEvent.click(screen.getByRole("button", { name: "onboarding.retry" }))

      expect(await screen.findByText("home")).toBeInTheDocument()
      // Only the retry asks the background to skip the language: it is already saved.
      expect(sendMessageMock.mock.calls).toEqual([
        ["onboardingTransition", { event: "complete", targetCode: "kor" }],
        [
          "onboardingTransition",
          { event: "complete", targetCode: "kor", retryCompletionOnly: true },
        ],
      ])
      expect(sendMessageMock.mock.calls[0]![1]).not.toHaveProperty("retryCompletionOnly")
      expect(setItemSpy).not.toHaveBeenCalled()
    })

    it("keeps the unfinished-setup state, and the retry-only request, if the retry fails too", async () => {
      sendMessageMock.mockResolvedValueOnce({ ok: false, reason: "lifecycle-save-failed" })
      sendMessageMock.mockResolvedValueOnce({ ok: false, reason: "target-save-failed" })
      sendMessageMock.mockRejectedValueOnce(new Error("no receiver"))
      sendMessageMock.mockResolvedValueOnce({ ok: true, status: "completed" })
      setBrowserLanguage("ko-KR")
      await renderPage("pending")
      await findQuestion()
      fireEvent.click(useButton())
      await screen.findByRole("alert")

      // Whatever the second answer is, only the record is left to write.
      fireEvent.click(screen.getByRole("button", { name: "onboarding.retry" }))
      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2))
      expect(await screen.findByRole("alert")).toHaveTextContent("onboarding.errorComplete")
      fireEvent.click(screen.getByRole("button", { name: "onboarding.retry" }))
      await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(3))
      expect(await screen.findByRole("alert")).toHaveTextContent("onboarding.errorComplete")
      fireEvent.click(screen.getByRole("button", { name: "onboarding.retry" }))

      expect(await screen.findByText("home")).toBeInTheDocument()
      expect(sendMessageMock.mock.calls.slice(1).map(([, action]) => action)).toEqual([
        { event: "complete", targetCode: "kor", retryCompletionOnly: true },
        { event: "complete", targetCode: "kor", retryCompletionOnly: true },
        { event: "complete", targetCode: "kor", retryCompletionOnly: true },
      ])
    })

    it("confirms the same selection with Use as a retry while the unfinished-setup state shows", async () => {
      sendMessageMock.mockResolvedValueOnce({ ok: false, reason: "lifecycle-save-failed" })
      sendMessageMock.mockResolvedValueOnce({ ok: true, status: "completed" })
      setBrowserLanguage("ko-KR")
      await renderPage("pending")
      await findQuestion()
      fireEvent.click(useButton())
      await screen.findByRole("alert")

      fireEvent.click(useButton())

      await screen.findByText("home")
      expect(sendMessageMock.mock.calls[1]).toEqual([
        "onboardingTransition",
        { event: "complete", targetCode: "kor", retryCompletionOnly: true },
      ])
    })

    it("clears the error when another language is picked, and sends the new choice", async () => {
      sendMessageMock.mockResolvedValueOnce({ ok: false, reason: "lifecycle-save-failed" })
      sendMessageMock.mockResolvedValueOnce({ ok: true, status: "completed" })
      setBrowserLanguage("ko-KR")
      await renderPage("pending")
      await findQuestion()
      fireEvent.click(useButton())
      await screen.findByRole("alert")

      fireEvent.click(picker())

      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      fireEvent.click(useButton())
      await screen.findByText("home")
      // A new choice is an ordinary confirmation: it carries no retry flag.
      expect(sendMessageMock.mock.calls[1]).toEqual([
        "onboardingTransition",
        { event: "complete", targetCode: "jpn" },
      ])
      expect(sendMessageMock.mock.calls[1]![1]).not.toHaveProperty("retryCompletionOnly")
    })

    it("treats an unreachable background as a failed language save", async () => {
      sendMessageMock.mockRejectedValue(new Error("no receiver"))
      await renderPage("pending")
      await findQuestion()

      fireEvent.click(useButton())

      expect(await screen.findByRole("alert")).toHaveTextContent("onboarding.errorTarget")
      expect(useButton()).toBeEnabled()
      expect(sendMessageMock.mock.calls[0]![1]).not.toHaveProperty("retryCompletionOnly")
    })

    it("never sends the retry flag for the first confirmation or a failed language save", async () => {
      sendMessageMock.mockResolvedValueOnce({ ok: false, reason: "target-save-failed" })
      sendMessageMock.mockResolvedValueOnce({ ok: true, status: "completed" })
      await renderPage("pending")
      await findQuestion()
      fireEvent.click(useButton())
      await screen.findByRole("alert")

      fireEvent.click(useButton())

      await screen.findByText("home")
      for (const [, action] of sendMessageMock.mock.calls) {
        expect(action).not.toHaveProperty("retryCompletionOnly")
      }
    })
  })

  describe("Later", () => {
    it("sends only a dismissal, saves no language, and leaves", async () => {
      sendMessageMock.mockResolvedValue({ ok: true, status: "dismissed" })
      setBrowserLanguage("ko-KR")
      await renderPage("pending")
      await findQuestion()

      fireEvent.click(laterButton())

      expect(await screen.findByText("home")).toBeInTheDocument()
      expect(sendMessageMock).toHaveBeenCalledOnce()
      expect(sendMessageMock).toHaveBeenCalledWith("onboardingTransition", { event: "dismiss" })
      expect(setItemSpy).not.toHaveBeenCalled()
    })

    it.each([
      [
        "a failed save",
        () => sendMessageMock.mockResolvedValue({ ok: false, reason: "lifecycle-save-failed" }),
      ],
      [
        "an unreachable background",
        () => sendMessageMock.mockRejectedValue(new Error("no receiver")),
      ],
    ])("explains %s and stays on the question", async (_label, arrange) => {
      arrange()
      await renderPage("pending")
      await findQuestion()

      fireEvent.click(laterButton())

      expect(await screen.findByRole("alert")).toHaveTextContent("onboarding.errorLater")
      expect(screen.queryByText("home")).not.toBeInTheDocument()
      expect(laterButton()).toBeEnabled()
    })
  })

  it("saves nothing when the page is closed", async () => {
    setBrowserLanguage("ko-KR")
    const { unmount } = await renderPage("pending")
    await findQuestion()

    unmount()
    await settle()

    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(await storage.getItem(onboardingKey)).toEqual({ version: 1, status: "pending" })
  })
})

describe("OnboardingPage for a profile with nothing to ask", () => {
  it.each(["absent", "completed", "invalid"] as const)(
    "shows the settings pointer for %s and writes nothing",
    async (status) => {
      await renderPage(status)

      expect(
        await screen.findByRole("heading", { level: 1, name: "onboarding.doneTitle" }),
      ).toBeInTheDocument()
      expect(screen.getByText("onboarding.doneDescription")).toBeInTheDocument()
      expect(screen.getByText("onboarding.goSettings").closest("a")).toHaveAttribute(
        "href",
        "/preference",
      )
      expect(screen.queryByText("onboarding.title")).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "onboarding.use" })).not.toBeInTheDocument()

      await settle()
      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(setItemSpy).not.toHaveBeenCalled()
    },
  )

  it("leaves the stored record exactly as it was", async () => {
    await renderPage("completed")
    await screen.findByRole("heading", { level: 1, name: "onboarding.doneTitle" })

    expect(await storage.getItem(onboardingKey)).toEqual({ version: 1, status: "completed" })
  })
})

describe("OnboardingRootGuard", () => {
  function NavigationProbe() {
    return <div>{`onboarding:${useNavigationType()}`}</div>
  }

  function renderRoot() {
    return render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={
              <OnboardingRootGuard>
                <div>settings</div>
              </OnboardingRootGuard>
            }
          />
          <Route path="/onboarding" element={<NavigationProbe />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it("replaces the root with the question while it is pending", async () => {
    await storage.setItem(onboardingKey, { version: 1, status: "pending" })

    renderRoot()

    expect(await screen.findByText("onboarding:REPLACE")).toBeInTheDocument()
  })

  it.each(["dismissed", "completed"] as const)("does not redirect a %s profile", async (status) => {
    await storage.setItem(onboardingKey, { version: 1, status })

    renderRoot()
    await settle()

    expect(screen.getByText("settings")).toBeInTheDocument()
    expect(screen.queryByText(/^onboarding:/)).not.toBeInTheDocument()
  })

  it.each([
    ["absent (an existing user)", undefined],
    ["unreadable", { version: 9, status: "pending" }],
  ])("does not redirect a profile whose record is %s", async (_label, record) => {
    if (record) await storage.setItem(onboardingKey, record)

    renderRoot()
    await settle()

    expect(screen.getByText("settings")).toBeInTheDocument()
    expect(screen.queryByText(/^onboarding:/)).not.toBeInTheDocument()
  })
})
