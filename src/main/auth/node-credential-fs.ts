import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CredentialFileSystem } from './safe-storage-credential-store'

/** Owner-only file, written to a temp file first so a crash never leaves a truncated credential. */
export const nodeCredentialFs: CredentialFileSystem = {
  async read(path) {
    try {
      return await readFile(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
  async write(path, data) {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    await writeFile(temporary, data, { mode: 0o600 })
    await rename(temporary, path)
  },
  async remove(path) {
    await rm(path, { force: true })
  }
}
