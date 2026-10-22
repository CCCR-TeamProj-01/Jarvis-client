/** A file store kept in memory, for the code that reads and replaces one JSON document. */
export class MemoryFiles {
  contents: string | null = null
  /** How many times the document was replaced. */
  writes = 0
  failWrites = false
  failReads = false

  async read(): Promise<string | null> {
    if (this.failReads) throw new Error('read failed')
    return this.contents
  }

  async replace(_name: string, contents: string): Promise<void> {
    if (this.failWrites) throw new Error('write failed')
    this.writes += 1
    this.contents = contents
  }
}
