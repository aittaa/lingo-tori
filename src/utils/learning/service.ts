import type { LearningState, ReviewEvent } from "./core"
import { sha256 } from "js-sha256"
import { z } from "zod"
import {
  canonicalNoteId,
  createState,
  dueCards,
  mergeStates,
  normalizeLearningLanguage,
  reviewCard,
  saveNote,
} from "./core"

export const noteInputSchema = z
  .object({
    term: z.string().trim().min(1).max(500),
    meaning: z.string().max(5000).default(""),
    context: z.string().max(10000).default(""),
    language: z.string().max(40).default(""),
    sourceUrl: z.string().max(4000).default(""),
  })
  .strict()
export type NoteInput = z.input<typeof noteInputSchema>
export const syncConfigSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value)
        return (
          url.protocol === "http:" &&
          url.hostname === "127.0.0.1" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === "/"
        )
      }, "Use a loopback HTTP server origin, such as http://127.0.0.1:4317"),
    secret: z.string().min(24).max(1024),
  })
  .strict()
export type SyncConfig = z.infer<typeof syncConfigSchema>
export interface LearningPersistence {
  read(): Promise<LearningState | undefined>
  write(state: LearningState): Promise<void>
  readSync(): Promise<SyncConfig | undefined>
  writeSync(config: SyncConfig | undefined): Promise<void>
}
export function sanitizeSourceUrl(value: string): string {
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol)) return ""
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return ""
  }
}
export function noteId(term: string, language: string): string {
  return sha256(JSON.stringify([term.normalize("NFC").trim(), normalizeLearningLanguage(language)]))
}
export function validateState(value: unknown): LearningState {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 5_000_000)
    throw new Error("Learning data exceeds 5 MB")
  return mergeStates(value as LearningState)
}

export function createLearningService(store: LearningPersistence, fetcher: typeof fetch = fetch) {
  let queue = Promise.resolve()
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const read = async () => validateState((await store.read()) ?? createState())
  const commit = async (state: LearningState) => {
    const validated = validateState(state)
    await store.write(validated)
    return validated
  }
  return {
    read: () => serial(read),
    counts: () =>
      serial(async () => {
        const state = await read()
        return { notes: state.notes.length, due: dueCards(state).length }
      }),
    save: (input: unknown) =>
      serial(async () => {
        const notes = z.array(noteInputSchema).min(1).max(100).parse(input)
        let state = await read()
        for (const note of notes) {
          const id = await canonicalNoteId(note.term, note.language, state)
          state = saveNote(state, {
            ...note,
            term: note.term.normalize("NFC"),
            language: normalizeLearningLanguage(note.language),
            id,
            sourceUrl: sanitizeSourceUrl(note.sourceUrl),
            updatedAt: Math.max(
              Date.now(),
              (state.notes.find((existing) => existing.id === id)?.updatedAt ?? 0) + 1,
            ),
          })
        }
        await commit(state)
        return { saved: notes.length }
      }),
    review: (event: ReviewEvent) => serial(async () => commit(reviewCard(await read(), event))),
    import: (value: unknown) =>
      serial(async () => commit(mergeStates(await read(), validateState(value)))),
    configStatus: () =>
      serial(async () => {
        const config = await store.readSync()
        return { url: config?.url ?? "", configured: !!config }
      }),
    configure: (input: unknown) =>
      serial(async () => {
        await store.writeSync(input === null ? undefined : syncConfigSchema.parse(input))
      }),
    sync: () =>
      serial(async () => {
        const config = syncConfigSchema.parse(await store.readSync())
        const local = await read()
        const response = await fetcher(new URL("/api/sync", config.url), {
          method: "POST",
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.secret}` },
          body: JSON.stringify({ state: local }),
          signal: AbortSignal.timeout(15000),
        })
        if (!response.ok)
          throw new Error(`Sync failed (${response.status}); local data is unchanged`)
        const body = await response.text()
        if (new TextEncoder().encode(body).length > 5_000_000)
          throw new Error("Sync response exceeds 5 MB")
        const result = z.object({ state: z.unknown() }).strict().parse(JSON.parse(body))
        return commit(mergeStates(local, validateState(result.state)))
      }),
  }
}
