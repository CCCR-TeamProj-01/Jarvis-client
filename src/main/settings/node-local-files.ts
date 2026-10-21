import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { LocalFileName, LocalFilesPort } from './ports'

type FileOperations = Pick<typeof fs, 'readFile' | 'mkdir' | 'open' | 'link' | 'rename' | 'rm'>

/** Complete, owner-only files. Initial publication never replaces another initializer's key. */
export class NodeLocalFiles implements LocalFilesPort {
  constructor(
    private readonly directory: string,
    private readonly files: FileOperations = fs
  ) {}

  async read(name: LocalFileName): Promise<string | null> {
    try {
      return await this.files.readFile(join(this.directory, name), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async create(name: LocalFileName, contents: string): Promise<'created' | 'exists'> {
    return this.publish(name, contents, false)
  }

  async replace(name: LocalFileName, contents: string): Promise<void> {
    await this.publish(name, contents, true)
  }

  private async publish(
    name: LocalFileName,
    contents: string,
    replace: boolean
  ): Promise<'created' | 'exists'> {
    await this.files.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const destination = join(this.directory, name)
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      const handle = await this.files.open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(contents, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (replace) await this.files.rename(temporary, destination)
      else {
        try {
          // A hard link publishes the complete inode atomically and refuses to replace a winner.
          await this.files.link(temporary, destination)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
          throw error
        }
      }
      return 'created'
    } finally {
      // Publication may already have succeeded; cleanup failure must not turn it into a retry.
      await this.files.rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}
