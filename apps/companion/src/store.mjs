import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, lstat, open, rename, unlink, realpath } from "node:fs/promises"
import { resolve, dirname, join } from "node:path"
import { CompanionError } from "./core.mjs"
export class CredentialStore {
  constructor(directory, filename = "session.json") {
    this.directory = resolve(directory)
    if (!["session.json", "bridge.json"].includes(filename))
      throw new CompanionError("invalid_store_path")
    this.path = join(this.directory, filename)
  }
  async prepare() {
    if (process.platform === "win32") throw new CompanionError("protected_store_unsupported")
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      info.mode & 0o077 ||
      info.uid !== process.getuid() ||
      (await realpath(this.directory)) !== this.directory
    )
      throw new CompanionError("unsafe_store_directory")
  }
  async read() {
    await this.prepare()
    let handle
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.mode & 0o077 ||
        info.uid !== process.getuid() ||
        info.size > 100000
      )
        throw new CompanionError("unsafe_credential_file")
      return JSON.parse(await handle.readFile("utf8"))
    } catch (error) {
      if (error.code === "ENOENT") return null
      throw new CompanionError("credential_store_failure")
    } finally {
      await handle?.close()
    }
  }
  async write(record) {
    await this.prepare()
    try {
      const info = await lstat(this.path)
      if (
        info.isSymbolicLink() ||
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid() ||
        info.mode & 0o077
      )
        throw new Error()
    } catch (error) {
      if (error.code !== "ENOENT") throw new CompanionError("unsafe_credential_file")
    }
    const temp = join(this.directory, `.pending-${randomUUID()}`)
    let handle
    try {
      handle = await open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      await handle.writeFile(JSON.stringify(record))
      await handle.sync()
      await handle.close()
      handle = null
      await rename(temp, this.path)
      const directory = await open(dirname(this.path), constants.O_RDONLY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } finally {
      await handle?.close()
      await unlink(temp).catch(() => {})
    }
  }
  async lock() {
    await this.prepare()
    const path = join(this.directory, "runtime.lock")
    let handle
    try {
      handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      await handle.writeFile(String(process.pid))
    } catch {
      throw new CompanionError("runtime_already_locked")
    }
    return async () => {
      await handle.close()
      await unlink(path)
    }
  }
}
