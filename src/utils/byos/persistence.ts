import type { Table } from "dexie"
import type { BridgeConfig, BridgeStore } from "./service"
import { Dexie } from "dexie"
class BridgeDatabase extends Dexie {
  records!: Table<{ key: string; value: BridgeConfig }, string>
  constructor() {
    super("lingotori-byos-bridge")
    this.version(1).stores({ records: "key" })
  }
}
// This database is opened exclusively by the extension background. Content
// scripts have page-origin IndexedDB and no message can read this credential.
export function createBridgeStore(): BridgeStore {
  const db = new BridgeDatabase()
  return {
    read: async () => (await db.records.get("connection"))?.value,
    write: async (config) => {
      if (config) await db.records.put({ key: "connection", value: config })
      else await db.records.delete("connection")
    },
  }
}
