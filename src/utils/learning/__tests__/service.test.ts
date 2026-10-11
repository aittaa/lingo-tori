import type { LearningPersistence, SyncConfig } from "../service"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TextEncoder as NativeTextEncoder } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createState, saveNote } from "../core"
import { createLearningService, noteId, sanitizeSourceUrl, syncConfigSchema } from "../service"

beforeEach(() => vi.stubGlobal("TextEncoder", NativeTextEncoder))
const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function persistentStore(): Promise<LearningPersistence> {
  const directory = await mkdtemp(join(tmpdir(), "lingotori-learning-test-"))
  directories.push(directory)
  const path = join(directory, "state.json")
  let config: SyncConfig | undefined
  return {
    read: async () => {
      try {
        return JSON.parse(await readFile(path, "utf8"))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      }
    },
    write: async (state) => {
      await writeFile(path, JSON.stringify(state))
    },
    readSync: async () => config,
    writeSync: async (value) => {
      config = value
    },
  }
}
const note = {
  term: "猫",
  meaning: "cat",
  language: "jpn",
  context: "猫がいる",
  sourceUrl: "https://user:password@example.com/article?token=private#part",
}
const connection = { url: "http://127.0.0.1:4317", secret: "fixture-only-not-a-real-secret" }

describe("durable local learning service", () => {
  it("saves offline, reopens persisted state, deduplicates and preserves reviews on update", async () => {
    const store = await persistentStore()
    const service = createLearningService(store)
    await service.save([note])
    expect((await service.read()).notes[0]?.id).toBe(noteId(note.term, note.language))
    const event = {
      id: "review-1",
      cardId: noteId(note.term, note.language),
      rating: "good" as const,
      reviewedAt: 1000,
    }
    await service.review(event)
    const restarted = createLearningService(store)
    await restarted.save([{ ...note, meaning: "a cat" }])
    await restarted.review(event)
    const state = await restarted.read()
    expect(state.notes).toHaveLength(1)
    expect(state.notes[0]?.sourceUrl).toBe("https://example.com/article")
    expect(state.notes[0]?.meaning).toBe("a cat")
    expect(state.reviews).toEqual([event])
    expect(state.cards[0]?.repetitions).toBe(1)
  })
  it("serializes concurrent saves without lost updates", async () => {
    const service = createLearningService(await persistentStore())
    await Promise.all([service.save([{ term: "one" }]), service.save([{ term: "two" }])])
    expect((await service.read()).notes).toHaveLength(2)
  })
  it("reports write failures and can retry with no phantom saves", async () => {
    const store = await persistentStore()
    const write = store.write.bind(store)
    store.write = vi
      .fn<LearningPersistence["write"]>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementation(write)
    const service = createLearningService(store)
    await expect(service.save([note])).rejects.toThrow("disk full")
    expect((await service.read()).notes).toHaveLength(0)
    await service.save([note])
    expect((await service.read()).notes).toHaveLength(1)
  })
  it("rejects bad batches and conflicting imports without changing stored history", async () => {
    const service = createLearningService(await persistentStore())
    await expect(service.save([note, { term: "" }])).rejects.toThrow(/.+/)
    expect((await service.read()).notes).toHaveLength(0)
    await service.save([note])
    const event = {
      id: "same",
      cardId: noteId(note.term, note.language),
      rating: "easy" as const,
      reviewedAt: 1000,
    }
    await service.review(event)
    const before = await service.read()
    await expect(
      service.import({ ...before, reviews: [{ ...event, rating: "hard" }] }),
    ).rejects.toThrow("conflict")
    expect(await service.read()).toEqual(before)
    await expect(service.import({ ...before, secret: "not allowed" })).rejects.toThrow(/.+/)
  })
  it("keeps local events after failed sync and merges idempotently on retry", async () => {
    const store = await persistentStore()
    const remote = saveNote(createState(), {
      id: "remote",
      term: "犬",
      meaning: "dog",
      language: "jpn",
      context: "",
      sourceUrl: "",
      updatedAt: 1,
    })
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async () => new Response(JSON.stringify({ state: remote })))
    const service = createLearningService(store, fetcher)
    await service.save([note])
    await service.configure(connection)
    const before = await service.read()
    await expect(service.sync()).rejects.toThrow("offline")
    expect(await service.read()).toEqual(before)
    await service.sync()
    await service.sync()
    expect((await service.read()).notes).toHaveLength(2)
    expect(JSON.stringify(await service.read())).not.toContain(connection.secret)
    expect(await service.configStatus()).toEqual({ url: connection.url, configured: true })
    const options = fetcher.mock.calls[1]![1]!
    expect(options.redirect).toBe("error")
    expect(options.credentials).toBe("omit")
    expect((options.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${connection.secret}`,
    )
    await service.configure(null)
    expect((await service.configStatus()).configured).toBe(false)
  })
  it("rejects non-loopback destinations and rejects invalid sync responses atomically", async () => {
    for (const url of [
      "https://example.com",
      "http://127.0.0.1.evil.test",
      "http://secret@localhost",
      "http://localhost/?secret=a",
    ])
      expect(syncConfigSchema.safeParse({ ...connection, url }).success).toBe(false)
    const service = createLearningService(
      await persistentStore(),
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              state: {
                ...createState(),
                reviews: [{ id: "bad", cardId: "unknown", rating: "good", reviewedAt: 1 }],
              },
            }),
          ),
      ),
    )
    await service.save([note])
    await service.configure(connection)
    const before = await service.read()
    await expect(service.sync()).rejects.toThrow(/.+/)
    expect(await service.read()).toEqual(before)
  })
  it("normalizes duplicate identity and removes unsafe source URL data", () => {
    expect(noteId(" café ", "fra")).toBe(noteId("cafe\u0301", "fra"))
    expect(sanitizeSourceUrl("javascript:alert(1)")).toBe("")
    expect(sanitizeSourceUrl(note.sourceUrl)).toBe("https://example.com/article")
  })
  it("updates imported alias vocabulary without losing its original ID or reviews", async () => {
    const service = createLearningService(await persistentStore())
    const previous = saveNote(createState(), {
      id: "legacy-ja",
      term: "猫",
      language: "jpn",
      meaning: "cat",
      context: "",
      sourceUrl: "",
      updatedAt: 1,
    })
    await service.import(previous)
    await service.review({
      id: "old-review",
      cardId: "legacy-ja",
      rating: "good",
      reviewedAt: 1000,
    })
    const before = await service.read()
    await service.save([{ term: "猫", language: "ja", meaning: "updated cat" }])
    const after = await service.read()
    expect(after.notes).toHaveLength(1)
    expect(after.notes[0]?.id).toBe("legacy-ja")
    expect(after.reviews).toEqual(before.reviews)
    expect(after.cards).toEqual(before.cards)
  })
})
