import { afterEach, describe, expect, it, vi } from "vitest"
import { TranslationCoordinator } from "../translation-coordinator"

describe("translation coordinator loading state", () => {
  it("sets loading for the active untranslated cue", () => {
    const onStateChange = vi.fn<(...args: any[]) => any>()
    const coordinator = new TranslationCoordinator({
      getFragments: () => [{ text: "hello", start: 0, end: 1000 }],
      getVideoElement: () => ({ currentTime: 0.5 }) as HTMLVideoElement,
      getCurrentState: () => "idle",
      segmentationPipeline: null,
      onTranslated: vi.fn<(...args: any[]) => any>(),
      onStateChange,
    })

    ;(coordinator as any).updateLoadingStateAt(500, [{ text: "hello", start: 0, end: 1000 }])

    expect(onStateChange).toHaveBeenCalledWith("loading")
  })

  it("does not keep loading in a cue gap just because the next cue is untranslated", () => {
    const onStateChange = vi.fn<(...args: any[]) => any>()
    const coordinator = new TranslationCoordinator({
      getFragments: () => [
        { text: "hello", start: 0, end: 1000 },
        { text: "world", start: 2000, end: 3000 },
      ],
      getVideoElement: () => ({ currentTime: 1.5 }) as HTMLVideoElement,
      getCurrentState: () => "loading",
      segmentationPipeline: null,
      onTranslated: vi.fn<(...args: any[]) => any>(),
      onStateChange,
    })

    // Pretend we were loading on the previous cue.
    ;(coordinator as any).lastEmittedState = "loading"
    ;(coordinator as any).updateLoadingStateAt(1500, [
      { text: "hello", start: 0, end: 1000 },
      { text: "world", start: 2000, end: 3000 },
    ])

    expect(onStateChange).toHaveBeenCalledWith("idle")
  })

  it("clears adapter loading during a music intro with no active cue", () => {
    const onStateChange = vi.fn<(...args: any[]) => any>()
    const coordinator = new TranslationCoordinator({
      getFragments: () => [{ text: "lyrics start later", start: 30_000, end: 31_000 }],
      getVideoElement: () => ({ currentTime: 5 }) as HTMLVideoElement,
      // Scheduler was set to loading while source subtitles were fetched.
      getCurrentState: () => "loading",
      segmentationPipeline: null,
      onTranslated: vi.fn<(...args: any[]) => any>(),
      onStateChange,
    })

    // Coordinator starts with lastEmittedState = "idle", which previously skipped clear.
    ;(coordinator as any).updateLoadingStateAt(5_000, [
      { text: "lyrics start later", start: 30_000, end: 31_000 },
    ])

    expect(onStateChange).toHaveBeenCalledWith("idle")
  })

  it("does not chain another translation tick after stop", async () => {
    const onTranslated = vi.fn<(...args: any[]) => any>()
    const onStateChange = vi.fn<(...args: any[]) => any>()
    let resolveTranslate!: (value: any) => void
    const translatePromise = new Promise((resolve) => {
      resolveTranslate = resolve
    })

    const translator = await import("@/utils/subtitles/processor/translator")
    const spy = vi
      .spyOn(translator, "translateSubtitles")
      .mockImplementation(() => translatePromise as any)

    const coordinator = new TranslationCoordinator({
      getFragments: () => [
        { text: "a", start: 0, end: 1000 },
        { text: "b", start: 1000, end: 2000 },
        { text: "c", start: 2000, end: 3000 },
        { text: "d", start: 3000, end: 4000 },
        { text: "e", start: 4000, end: 5000 },
        { text: "f", start: 5000, end: 6000 },
      ],
      getVideoElement: () =>
        ({
          currentTime: 0,
          addEventListener: vi.fn<(...args: any[]) => any>(),
          removeEventListener: vi.fn<(...args: any[]) => any>(),
        }) as unknown as HTMLVideoElement,
      getCurrentState: () => "idle",
      segmentationPipeline: null,
      onTranslated,
      onStateChange,
    })

    coordinator.start()
    await Promise.resolve()
    expect(spy).toHaveBeenCalledTimes(1)

    coordinator.stop()
    const firstCall = spy.mock.calls[0]!
    const batch = firstCall[0] as Array<{ text: string; start: number; end: number }>
    resolveTranslate(batch.map((f) => ({ ...f, translation: `t:${f.text}` })))
    await Promise.resolve()
    await Promise.resolve()

    // In-flight call may finish, but stop must not chain another nearby batch.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(onTranslated).not.toHaveBeenCalled()

    spy.mockRestore()
  })

  it("invalidates translated bookkeeping when the same start is recut", () => {
    let fragments = [{ text: "hello world", start: 0, end: 2000 }]
    const onStateChange = vi.fn<(...args: any[]) => any>()
    const coordinator = new TranslationCoordinator({
      getFragments: () => fragments,
      getVideoElement: () =>
        ({
          currentTime: 0.2,
          addEventListener: vi.fn<(...args: any[]) => any>(),
          removeEventListener: vi.fn<(...args: any[]) => any>(),
        }) as unknown as HTMLVideoElement,
      getCurrentState: () => "idle",
      segmentationPipeline: null,
      onTranslated: vi.fn<(...args: any[]) => any>(),
      onStateChange,
    })

    // noteFragmentListChanged is a no-op when inactive.
    ;(coordinator as any).active = true
    ;(coordinator as any).translatedStarts.add(0)
    ;(coordinator as any).knownIdentities.set(0, "2000\0hello world")

    // AI re-segmentation keeps start=0 but shortens the cue.
    fragments = [
      { text: "hello", start: 0, end: 1000 },
      { text: "world", start: 1000, end: 2000 },
    ]
    coordinator.noteFragmentListChanged()

    // Old completion must be invalidated so the recut line can be translated again.
    expect((coordinator as any).translatedStarts.has(0)).toBe(false)
    // Old baseline identity must not stick around as if still valid.
    expect((coordinator as any).knownIdentities.get(0)).not.toBe("2000\0hello world")
  })

  it("does not apply in-flight results after stop then start", async () => {
    const onTranslated = vi.fn<(...args: any[]) => any>()
    const resolvers: Array<(value: any) => void> = []
    const translator = await import("@/utils/subtitles/processor/translator")
    const spy = vi.spyOn(translator, "translateSubtitles").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        }) as any,
    )

    const coordinator = new TranslationCoordinator({
      getFragments: () => [{ text: "a", start: 0, end: 1000 }],
      getVideoElement: () =>
        ({
          currentTime: 0.2,
          addEventListener: vi.fn<(...args: any[]) => any>(),
          removeEventListener: vi.fn<(...args: any[]) => any>(),
        }) as unknown as HTMLVideoElement,
      getCurrentState: () => "idle",
      segmentationPipeline: null,
      onTranslated,
      onStateChange: vi.fn<(...args: any[]) => any>(),
    })

    coordinator.start()
    await Promise.resolve()
    expect(spy).toHaveBeenCalledTimes(1)

    coordinator.stop()
    coordinator.start()
    await Promise.resolve()
    // Resume must be able to start a new batch (isTranslating not stuck).
    expect(spy).toHaveBeenCalledTimes(2)

    // Stale first-run result.
    resolvers[0]!([{ text: "a", start: 0, end: 1000, translation: "STALE" }])
    await Promise.resolve()
    await Promise.resolve()
    expect(onTranslated).not.toHaveBeenCalled()

    // Current-run result.
    resolvers[1]!([{ text: "a", start: 0, end: 1000, translation: "FRESH" }])
    await Promise.resolve()
    await Promise.resolve()
    expect(onTranslated).toHaveBeenCalledWith([expect.objectContaining({ translation: "FRESH" })])

    spy.mockRestore()
  })

  it("widens the translation look-ahead window with playback rate", async () => {
    const translator = await import("@/utils/subtitles/processor/translator")

    async function firstBatchStartsAtRate(playbackRate: number): Promise<number[]> {
      const spy = vi
        .spyOn(translator, "translateSubtitles")
        .mockImplementation((batch: any) => Promise.resolve(batch) as any)

      const coordinator = new TranslationCoordinator({
        // near cue (in the 1x window) + far cue (only reachable at higher rates)
        getFragments: () => [
          { text: "near", start: 1000, end: 2000 },
          { text: "far", start: 60_000, end: 61_000 },
        ],
        getVideoElement: () =>
          ({
            currentTime: 0,
            playbackRate,
            addEventListener: vi.fn<(...args: any[]) => any>(),
            removeEventListener: vi.fn<(...args: any[]) => any>(),
          }) as unknown as HTMLVideoElement,
        getCurrentState: () => "idle",
        segmentationPipeline: null,
        onTranslated: vi.fn<(...args: any[]) => any>(),
        onStateChange: vi.fn<(...args: any[]) => any>(),
      })

      coordinator.start()
      await Promise.resolve()
      coordinator.stop()

      const batch = (spy.mock.calls[0]?.[0] ?? []) as Array<{ start: number }>
      spy.mockRestore()
      return batch.map((f) => f.start)
    }

    // 1x: 30s window excludes the 60s cue.
    expect(await firstBatchStartsAtRate(1)).toEqual([1000])
    // 3x: 90s window now reaches the 60s cue.
    expect(await firstBatchStartsAtRate(3)).toEqual([1000, 60_000])
  })

  it("does not publish stale batch cues on translation failure after a recut", async () => {
    let fragments = [
      { text: "hello world", start: 0, end: 2000 },
      { text: "next", start: 2000, end: 3000 },
    ]
    const onTranslated = vi.fn<(...args: any[]) => any>()
    const onStateChange = vi.fn<(...args: any[]) => any>()

    const translator = await import("@/utils/subtitles/processor/translator")
    const spy = vi
      .spyOn(translator, "translateSubtitles")
      .mockRejectedValue(new Error("translate failed"))

    const config = await import("@/utils/config/storage")
    const configSpy = vi.spyOn(config, "getLocalConfig").mockResolvedValue({
      videoSubtitles: { style: { displayMode: "bilingual" } },
    } as any)

    const coordinator = new TranslationCoordinator({
      getFragments: () => fragments,
      getVideoElement: () =>
        ({
          currentTime: 0.2,
          addEventListener: vi.fn<(...args: any[]) => any>(),
          removeEventListener: vi.fn<(...args: any[]) => any>(),
        }) as unknown as HTMLVideoElement,
      getCurrentState: () => "idle",
      segmentationPipeline: null,
      onTranslated,
      onStateChange,
    })

    coordinator.start()
    await Promise.resolve()
    // Recut mid-request: original cue is gone; only identity-valid fallbacks may publish.
    fragments = [
      { text: "hello", start: 0, end: 1000 },
      { text: "world", start: 1000, end: 2000 },
      { text: "next", start: 2000, end: 3000 },
    ]
    await vi.waitFor(() => {
      expect(onStateChange).toHaveBeenCalledWith("error", { message: "translate failed" })
    })

    // Stale full-batch fallback would re-introduce the pre-recut cue as a zombie.
    const published = onTranslated.mock.calls.flatMap((call) => call[0] as any[])
    expect(published.every((f) => f.text !== "hello world")).toBe(true)
    // Empty translation fallbacks for still-valid cues are fine; identity-mismatched are not.
    expect(published.some((f) => f.start === 0 && f.end === 2000)).toBe(false)

    spy.mockRestore()
    configSpy.mockRestore()
  })

  describe("partially failed batches", () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    type Cue = { text: string; start: number; end: number; translation?: string }

    const cue = (text: string, start: number, end = start + 1000): Cue => ({ text, start, end })
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    const startsOf = (cues: Array<{ start: number }>) => cues.map((c) => c.start)
    // A failed cue is shown settled and empty, so the player does not read it as still translating.
    const withTranslation = (cues: Cue[]) => cues.filter((c) => c.translation)
    const settledEmpty = (cues: Cue[]) => cues.filter((c) => c.translation === "")

    /** A coordinator over a mutable cue list, with a player whose events a test can fire. */
    function setup(
      initial: Cue[],
      currentTime = 0.2,
      options: { targetCode?: "kor" | "jpn" } = {},
    ) {
      const state = { fragments: initial }
      const listeners = new Map<string, Set<() => void>>()
      const video = {
        currentTime,
        addEventListener: vi.fn<(type: string, listener: () => void) => void>((type, listener) => {
          listeners.set(type, (listeners.get(type) ?? new Set()).add(listener))
        }),
        removeEventListener: vi.fn<(type: string, listener: () => void) => void>(
          (type, listener) => {
            listeners.get(type)?.delete(listener)
          },
        ),
      }
      const onTranslated = vi.fn<(fragments: Cue[]) => void>()
      const onStateChange = vi.fn<(...args: any[]) => any>()
      const coordinator = new TranslationCoordinator({
        getFragments: () => state.fragments,
        getVideoElement: () => video as unknown as HTMLVideoElement,
        getCurrentState: () => "idle",
        segmentationPipeline: null,
        onTranslated,
        onStateChange,
        ...options,
      })
      return {
        state,
        coordinator,
        onTranslated,
        onStateChange,
        /** Everything that reached the display so far, flattened across calls. */
        published: () => onTranslated.mock.calls.flatMap((call) => call[0]),
        fire: (type: string) => listeners.get(type)?.forEach((listener) => listener()),
        internals: coordinator as unknown as {
          translatingStarts: Set<number>
          translatedStarts: Set<number>
          failedStarts: Set<number>
        },
      }
    }

    async function mockTranslate() {
      const translator = await import("@/utils/subtitles/processor/translator")
      return vi.spyOn(translator, "translateSubtitles")
    }

    // A coordinator that retried a failed cue on every chained tick would spin on the microtask
    // queue and starve the timers a test waits on; past this many requests nothing settles, so the
    // loop ends and the call-count assertions fail instead of the run hanging.
    const RUNAWAY_REQUESTS = 25

    /** Translates every cue except the starts named, which come back untranslated. */
    const resolveExcept = (failing: number[], prefix = "t") => {
      let requests = 0
      return (batch: Cue[]) =>
        (++requests > RUNAWAY_REQUESTS
          ? new Promise(() => {})
          : Promise.resolve(
              batch.map((c) => ({
                ...c,
                translation: failing.includes(c.start) ? undefined : `${prefix}:${c.text}`,
              })),
            )) as any
    }

    it("completes the cues that translated and settles the failed one without completing it", async () => {
      const spy = (await mockTranslate()).mockImplementation(resolveExcept([1000]))
      const t = setup([cue("a", 0), cue("b", 1000), cue("c", 2000)])

      t.coordinator.start()
      await flush()

      expect(spy).toHaveBeenCalledTimes(1)
      expect(startsOf(withTranslation(t.published()))).toEqual([0, 2000])
      expect(startsOf(settledEmpty(t.published()))).toEqual([1000])
      expect([...t.internals.translatedStarts].sort((x, y) => x - y)).toEqual([0, 2000])
      expect([...t.internals.failedStarts]).toEqual([1000])
      expect(t.internals.translatingStarts.size).toBe(0)

      t.coordinator.stop()
      spy.mockRestore()
    })

    it("retries only the failed cue after a stop, clearFailed and start, keeping the rest", async () => {
      const spy = (await mockTranslate()).mockImplementation(resolveExcept([1000]))
      const t = setup([cue("a", 0), cue("b", 1000), cue("c", 2000)])

      t.coordinator.start()
      await flush()
      expect(spy).toHaveBeenCalledTimes(1)

      // What the adapter does when the viewer switches off and on again.
      spy.mockImplementation(resolveExcept([]))
      t.coordinator.stop()
      t.coordinator.clearFailed()
      t.coordinator.start()
      await flush()

      expect(spy).toHaveBeenCalledTimes(2)
      expect(startsOf(spy.mock.calls[1]![0])).toEqual([1000])
      // Earlier successes were published once and never withdrawn or repeated; the failed cue was
      // settled empty on the first pass and filled in by the retry.
      expect(startsOf(withTranslation(t.published()))).toEqual([0, 2000, 1000])
      expect(startsOf(settledEmpty(t.published()))).toEqual([1000])
      expect([...t.internals.translatedStarts].sort((x, y) => x - y)).toEqual([0, 1000, 2000])
      expect(t.internals.failedStarts.size).toBe(0)

      t.coordinator.stop()
      spy.mockRestore()
    })

    it("does not retry a failed cue on its own, however many ticks arrive", async () => {
      const spy = (await mockTranslate()).mockImplementation(resolveExcept([1000]))
      const t = setup([cue("a", 0), cue("b", 1000)])

      t.coordinator.start()
      await flush()
      expect(spy).toHaveBeenCalledTimes(1)

      for (let tick = 0; tick < 5; tick++) {
        t.fire("timeupdate")
        t.fire("seeked")
        t.coordinator.requestTick()
        await flush()
      }
      expect(spy).toHaveBeenCalledTimes(1)

      t.coordinator.stop()
      spy.mockRestore()
    })

    it("stays bounded when the retry fails again, until the next explicit clearFailed", async () => {
      const spy = (await mockTranslate()).mockImplementation(resolveExcept([1000]))
      const t = setup([cue("a", 0), cue("b", 1000)])

      t.coordinator.start()
      await flush()
      t.coordinator.stop()
      t.coordinator.clearFailed()
      t.coordinator.start()
      await flush()
      expect(spy).toHaveBeenCalledTimes(2)
      expect(startsOf(spy.mock.calls[1]![0])).toEqual([1000])

      for (let tick = 0; tick < 5; tick++) {
        t.fire("timeupdate")
        await flush()
      }
      expect(spy).toHaveBeenCalledTimes(2)
      expect([...t.internals.failedStarts]).toEqual([1000])
      expect(startsOf(withTranslation(t.published()))).toEqual([0])

      t.coordinator.stop()
      spy.mockRestore()
    })

    it("counts a failed active cue as resolved so loading does not stay up", async () => {
      const spy = (await mockTranslate()).mockImplementation(resolveExcept([1000]))
      const t = setup([cue("a", 0), cue("b", 1000)], 1.2)

      t.coordinator.start()
      await flush()

      expect(t.onStateChange).toHaveBeenCalledWith("loading")
      expect(t.onStateChange).toHaveBeenLastCalledWith("idle")
      // A partial failure is not an error state: that is reserved for a batch that all failed.
      expect(t.onStateChange).not.toHaveBeenCalledWith("error", expect.anything())

      t.coordinator.stop()
      spy.mockRestore()
    })

    it("still treats an empty resolved translation as complete", async () => {
      const spy = (await mockTranslate()).mockImplementation((batch: Cue[]) =>
        Promise.resolve(batch.map((c) => ({ ...c, translation: "" }))),
      )
      const t = setup([cue("a", 0)])

      t.coordinator.start()
      await flush()

      expect([...t.internals.translatedStarts]).toEqual([0])
      expect(t.internals.failedStarts.size).toBe(0)
      expect(t.published()).toEqual([expect.objectContaining({ start: 0, translation: "" })])

      t.coordinator.stop()
      spy.mockRestore()
    })

    it("does not record a failed cue that was recut mid-request, and translates its replacement", async () => {
      const spy = await mockTranslate()
      let release!: (value: any) => void
      spy.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          }) as any,
      )
      spy.mockImplementation(resolveExcept([]))
      const t = setup([cue("a", 0), cue("b b", 1000, 2000)])

      t.coordinator.start()
      await flush()
      // AI re-segmentation lands while the batch is in flight: start 1000 is now a different cue.
      t.state.fragments = [cue("a", 0), cue("b", 1000, 1500), cue("b", 1500, 2000)]
      const [batch] = spy.mock.calls[0]!
      release(batch.map((c: Cue) => ({ ...c, translation: c.start === 1000 ? undefined : "t:a" })))
      await flush()

      expect(t.internals.failedStarts.size).toBe(0)
      expect(t.published().every((c) => c.text !== "b b")).toBe(true)
      expect(startsOf(t.published())).toContain(0)
      // The recut cues are fresh work, picked up without anyone clearing a failure.
      expect(spy).toHaveBeenCalledTimes(2)
      expect(startsOf(spy.mock.calls[1]![0])).toEqual([1000, 1500])

      t.coordinator.stop()
      spy.mockRestore()
    })

    it("never publishes or records a cue recut after it translated", async () => {
      const spy = await mockTranslate()
      let release!: (value: any) => void
      spy.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          }) as any,
      )
      spy.mockImplementation(resolveExcept([]))
      const t = setup([cue("a a", 0, 2000)])

      t.coordinator.start()
      await flush()
      t.state.fragments = [cue("a", 0, 1000), cue("a", 1000, 2000)]
      release([{ ...cue("a a", 0, 2000), translation: "STALE" }])
      await flush()

      expect(t.published().some((c) => c.translation === "STALE")).toBe(false)
      expect(startsOf(spy.mock.calls[1]![0])).toEqual([0, 1000])

      t.coordinator.stop()
      spy.mockRestore()
    })

    describe("the language each batch is translated into", () => {
      /** The 4th argument of a translate call: the language the batch is pinned to. */
      const pinnedTo = (call: unknown[]) => call[3]

      it("pins every batch, retries included, to the language the session recorded", async () => {
        const spy = (await mockTranslate()).mockImplementation(resolveExcept([1000]))
        const t = setup([cue("a", 0), cue("b", 1000)], 0.2, { targetCode: "kor" })

        t.coordinator.start()
        await flush()
        spy.mockImplementation(resolveExcept([]))
        t.coordinator.stop()
        t.coordinator.clearFailed()
        t.coordinator.start()
        await flush()

        expect(spy).toHaveBeenCalledTimes(2)
        expect(spy.mock.calls.map(pinnedTo)).toEqual(["kor", "kor"])

        t.coordinator.stop()
        spy.mockRestore()
      })

      it("leaves the language to the current settings when the session recorded none", async () => {
        const spy = (await mockTranslate()).mockImplementation(resolveExcept([]))
        const t = setup([cue("a", 0)])

        t.coordinator.start()
        await flush()

        expect(spy).toHaveBeenCalledTimes(1)
        expect(pinnedTo(spy.mock.calls[0]!)).toBeUndefined()

        t.coordinator.stop()
        spy.mockRestore()
      })
    })

    describe("stale generations", () => {
      /** Two generations in flight: the first started before stop(), the second after start(). */
      async function twoGenerations(fragments: Cue[]) {
        const spy = await mockTranslate()
        const releases: Array<(value: any) => void> = []
        const rejects: Array<(reason: unknown) => void> = []
        spy.mockImplementation(
          () =>
            new Promise((resolve, reject) => {
              releases.push(resolve)
              rejects.push(reject)
            }) as any,
        )
        const t = setup(fragments)
        t.coordinator.start()
        await flush()
        t.coordinator.stop()
        t.coordinator.start()
        await flush()
        expect(spy).toHaveBeenCalledTimes(2)
        return { spy, t, releases, rejects }
      }

      it("lets a stale response resolve after the fresh one without overwriting it", async () => {
        const { spy, t, releases } = await twoGenerations([cue("a", 0)])

        releases[1]!([{ ...cue("a", 0), translation: "FRESH" }])
        await flush()
        releases[0]!([{ ...cue("a", 0), translation: "STALE" }])
        await flush()

        expect(t.published()).toEqual([expect.objectContaining({ translation: "FRESH" })])
        expect(t.published().some((c) => c.translation === "STALE")).toBe(false)

        t.coordinator.stop()
        spy.mockRestore()
      })

      it("does not clear the fresh generation's in-flight bookkeeping when a stale one settles", async () => {
        const { spy, t, releases } = await twoGenerations([cue("a", 0)])
        expect(t.internals.translatingStarts.has(0)).toBe(true)

        releases[0]!([{ ...cue("a", 0), translation: "STALE" }])
        await flush()

        // The fresh request for this cue is still running; the old one has no say over it.
        expect(t.internals.translatingStarts.has(0)).toBe(true)
        expect(t.internals.translatedStarts.size).toBe(0)
        expect(t.published()).toEqual([])

        releases[1]!([{ ...cue("a", 0), translation: "FRESH" }])
        await flush()
        expect(t.published()).toEqual([expect.objectContaining({ translation: "FRESH" })])
        expect(t.internals.translatingStarts.size).toBe(0)

        t.coordinator.stop()
        spy.mockRestore()
      })

      it("does not let a stale partial failure mark a cue failed for the fresh generation", async () => {
        const { spy, t, releases } = await twoGenerations([cue("a", 0), cue("b", 1000)])

        releases[0]!([{ ...cue("a", 0), translation: "t:a" }, { ...cue("b", 1000) }])
        await flush()

        expect(t.internals.failedStarts.size).toBe(0)
        expect(t.internals.translatedStarts.size).toBe(0)
        expect(t.published()).toEqual([])

        // The fresh generation still owns both cues and settles them itself.
        releases[1]!([{ ...cue("a", 0), translation: "t:a" }, { ...cue("b", 1000) }])
        await flush()
        expect(startsOf(withTranslation(t.published()))).toEqual([0])
        expect(startsOf(settledEmpty(t.published()))).toEqual([1000])
        expect([...t.internals.failedStarts]).toEqual([1000])

        t.coordinator.stop()
        spy.mockRestore()
      })

      it("ignores a stale rejection: no error state, no failure recorded, no fallback published", async () => {
        const { spy, t, rejects } = await twoGenerations([cue("a", 0)])

        rejects[0]!(new Error("old generation failed"))
        await flush()

        expect(t.onStateChange).not.toHaveBeenCalledWith("error", expect.anything())
        expect(t.internals.failedStarts.size).toBe(0)
        expect(t.published()).toEqual([])
        expect(t.internals.translatingStarts.has(0)).toBe(true)

        t.coordinator.stop()
        spy.mockRestore()
      })

      it("applies nothing from a request that was in flight when the player navigated away", async () => {
        const spy = await mockTranslate()
        let release!: (value: any) => void
        spy.mockImplementation(
          () =>
            new Promise((resolve) => {
              release = resolve
            }) as any,
        )
        const t = setup([cue("a", 0), cue("b", 1000)])
        t.coordinator.start()
        await flush()

        t.coordinator.reset()
        release([{ ...cue("a", 0), translation: "t:a" }, { ...cue("b", 1000) }])
        await flush()

        expect(t.published()).toEqual([])
        expect(t.internals.translatedStarts.size).toBe(0)
        expect(t.internals.failedStarts.size).toBe(0)
        expect(t.internals.translatingStarts.size).toBe(0)
        expect(spy).toHaveBeenCalledTimes(1)

        spy.mockRestore()
      })
    })
  })
})
