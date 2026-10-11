import type { ByosFailureDetails } from "./errors"
import type { ByosSession } from "./service"
import { Dexie } from "dexie"

export interface PendingAuth {
  state: string
  nonce: string
  verifier: string
  redirectUri: string
  tabId: number
  expires: number
  generation: number
  clientId?: string
  subject?: string
  claimed?: boolean
  relayStarted?: boolean
}
export interface Credentials {
  clientId: string
  subject: string
  email: string
  accessToken: string
  refreshToken: string
  scopes: string[]
  expires: number
}
export interface VaultRecord {
  hostId: string
  generation: number
  tokenVersion: number
  registration?: { clientId: string; subject: string; email: string }
  pending?: PendingAuth
  credentials?: Credentials
  refreshing?: boolean
  accessRejected?: boolean
  refreshUncertain?: boolean
  refreshConfigurationError?: boolean
  refreshRetryAfter?: number
  refreshFailures?: number
  refreshFailure?: ByosFailureDetails
  blocked?: ByosSession["state"]
}
export interface AuthVault {
  read(): Promise<VaultRecord>
  update<T>(change: (record: VaultRecord) => T): Promise<T>
}
export const newVaultRecord = (): VaultRecord => ({
  hostId: `urn:uuid:${crypto.randomUUID()}`,
  generation: 0,
  tokenVersion: 0,
})

/** Imported only by the background; never mixed into synced/exported settings. */
export function createAuthVault(): AuthVault {
  const db = new Dexie("lingotori-browser-byos-auth")
  db.version(1).stores({ privateRecords: "key" })
  const records = db.table<{ key: string; value: VaultRecord }, string>("privateRecords")
  return {
    read: () =>
      db.transaction("rw", records, async () => {
        const saved = await records.get("session")
        if (saved) return saved.value
        const value = newVaultRecord()
        await records.put({ key: "session", value })
        return value
      }),
    update: (change) =>
      db.transaction("rw", records, async () => {
        const record = (await records.get("session"))?.value ?? newVaultRecord()
        const result = change(record)
        await records.put({ key: "session", value: record })
        return result
      }),
  }
}
