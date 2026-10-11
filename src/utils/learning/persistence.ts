import type { Table } from "dexie"
import type { LearningState } from "./core"
import type { LearningPersistence, SyncConfig } from "./service"
import { Dexie } from "dexie"

// Opened only in the background extension origin. Content scripts cannot access
// this origin's IndexedDB, including the optional sync credential record.
class LearningDatabase extends Dexie {
  records!: Table<{ key: string; value: LearningState | SyncConfig }, string>
  constructor() {
    super("lingotori-learning")
    this.version(1).stores({ records: "key" })
  }
}
export function createLearningPersistence(): LearningPersistence {
  const db = new LearningDatabase()
  return {
    read: async () => (await db.records.get("state-v1"))?.value as LearningState | undefined,
    write: async (state) => {
      await db.records.put({ key: "state-v1", value: state })
    },
    readSync: async () => (await db.records.get("sync-v1"))?.value as SyncConfig | undefined,
    writeSync: async (config) => {
      if (config) await db.records.put({ key: "sync-v1", value: config })
      else await db.records.delete("sync-v1")
    },
  }
}
