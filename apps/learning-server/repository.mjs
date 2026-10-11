import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs"
import { basename, dirname, resolve, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createState, mergeStates } from "../../packages/learning-core/index.mjs"

export const MAX_STATE_BYTES = 5_000_000
function secureDatabasePath(path) {
  if (path === ":memory:") return path
  if (typeof path !== "string") throw new Error("Database path must be a local file")
  const absolute = resolve(path)
  const directory = realpathSync(dirname(absolute))
  const parent = statSync(directory)
  // Canonicalize parents (including macOS /var -> /private/var), then refuse
  // directories another OS user could use to swap the database or sidecars.
  if ((parent.mode & 0o022) !== 0 || (process.getuid && parent.uid !== process.getuid()))
    throw new Error("Database directory must be owned by this user and not writable by others")
  const target = join(directory, basename(absolute))
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const file = target + suffix
    try {
      const info = lstatSync(file)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error("Database files must be private regular files, not links")
    } catch (error) {
      if (error.code !== "ENOENT") throw error
      if (suffix) continue
    }
    const fd = openSync(
      file,
      constants.O_RDWR | constants.O_NOFOLLOW | (suffix ? 0 : constants.O_CREAT),
      0o600,
    )
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid()))
        throw new Error("Invalid database file")
      fchmodSync(fd, 0o600)
    } finally {
      closeSync(fd)
    }
  }
  return target
}
export class LearningRepository {
  constructor(path) {
    this.db = new DatabaseSync(secureDatabasePath(path))
    try {
      this.db.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS learning_state (account TEXT PRIMARY KEY, body TEXT NOT NULL)",
      )
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  read(account) {
    const row = this.db.prepare("SELECT body FROM learning_state WHERE account = ?").get(account)
    return row ? mergeStates(JSON.parse(row.body)) : createState()
  }
  sync(account, incoming) {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const state = mergeStates(this.read(account), incoming)
      const body = JSON.stringify(state)
      if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw new Error("Learning state exceeds 5 MB")
      this.db
        .prepare(
          "INSERT INTO learning_state(account,body) VALUES (?,?) ON CONFLICT(account) DO UPDATE SET body=excluded.body",
        )
        .run(account, body)
      this.db.exec("COMMIT")
      return state
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
  close() {
    this.db.close()
  }
}
