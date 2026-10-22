import { z } from 'zod'
import type { Result } from '../../shared/contracts/common'
import type { LocalFilesPort } from '../settings/ports'
import { CommandResultSchema } from './command-result'
import type { CommandResult } from './command-result'
import { interruptedResult } from './result-mapper'

/**
 * The record of what this device did with each server command, kept across restarts so a command
 * the server sends again is never run a second time. Only IDs, the state and the fixed-text result
 * are stored: never the command's arguments (a URL or folder can be private).
 *
 * - `started`: written *before* the command runs. If the app ends now, the next start turns it into
 *   an `unknown` result; the command is not retried.
 * - `finished`: the command ran (or was refused) and the result is waiting to be sent.
 * - `reported`: the server has stored the result.
 */
const EntrySchema = z.strictObject({
  userId: z.string().min(1),
  commandId: z.string().min(1),
  attemptNo: z.number().int().positive(),
  state: z.enum(['started', 'finished', 'reported']),
  result: CommandResultSchema.optional(),
  updatedAtUnixMs: z.number().int().nonnegative()
})
export type JournalEntry = z.infer<typeof EntrySchema>

const DocumentSchema = z.strictObject({ version: z.literal(1), entries: z.array(EntrySchema) })

export interface CommandKey {
  commandId: string
  attemptNo: number
}

export type BeginOutcome = { kind: 'started' } | { kind: 'existing'; entry: JournalEntry }

/** One user's view of the journal. Nothing of another user is ever visible through it. */
export interface UserJournal {
  /** Records that the command is about to run. `existing` means it was already seen: do not run. */
  begin(key: CommandKey): Promise<Result<BeginOutcome>>
  /** Records the result of a command that was started or refused. */
  finish(key: CommandKey, result: CommandResult): Promise<Result<void>>
  /** The server stored the result; it is not sent again. */
  markReported(key: CommandKey): Promise<Result<void>>
  get(key: CommandKey): Promise<Result<JournalEntry | undefined>>
  /** Results waiting to be sent, oldest first. */
  unreported(): Promise<Result<JournalEntry[]>>
}

interface JournalOptions {
  files: Pick<LocalFilesPort, 'read' | 'replace'>
  /** Wall-clock milliseconds. */
  now(): number
  /** Entries older than this are dropped. The server stops sending a command long before. */
  retentionMs?: number
  /** At most this many entries are kept per user; the oldest reported ones go first. */
  maxEntriesPerUser?: number
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_MAX_PER_USER = 500

const unavailable = (): Result<never> => ({
  ok: false,
  error: {
    code: 'unavailable',
    message: '명령 실행 기록을 읽거나 저장하지 못했어요. 앱을 종료한 뒤 저장 파일을 확인해 주세요.'
  }
})

const sameKey = (entry: JournalEntry, userId: string, key: CommandKey): boolean =>
  entry.userId === userId && entry.commandId === key.commandId && entry.attemptNo === key.attemptNo

/**
 * Every change is written out before the call returns. A file that cannot be read or understood is
 * never overwritten and every call fails: running commands without knowing what already ran could
 * run one twice.
 */
export class CommandJournal {
  private entries: JournalEntry[] | null = null
  private queue: Promise<void> = Promise.resolve()
  private readonly retentionMs: number
  private readonly maxPerUser: number

  constructor(private readonly options: JournalOptions) {
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS
    this.maxPerUser = options.maxEntriesPerUser ?? DEFAULT_MAX_PER_USER
  }

  forUser(userId: string): UserJournal {
    return {
      begin: (key) =>
        this.enqueue(async () => {
          const loaded = await this.load()
          if (!loaded.ok) return loaded
          const existing = loaded.value.find((entry) => sameKey(entry, userId, key))
          if (existing) return { ok: true, value: { kind: 'existing', entry: { ...existing } } }
          const entry: JournalEntry = {
            userId,
            commandId: key.commandId,
            attemptNo: key.attemptNo,
            state: 'started',
            updatedAtUnixMs: this.options.now()
          }
          // The record must be on disk before anything runs. If it cannot be written, nothing runs.
          const written = await this.write([...loaded.value, entry], userId)
          if (!written.ok) return written
          return { ok: true, value: { kind: 'started' } }
        }),
      finish: (key, result) =>
        this.update(userId, key, (entry) => ({ ...entry, state: 'finished', result })),
      markReported: (key) => this.update(userId, key, (entry) => ({ ...entry, state: 'reported' })),
      get: (key) =>
        this.enqueue(async () => {
          const loaded = await this.load()
          if (!loaded.ok) return loaded
          const entry = loaded.value.find((candidate) => sameKey(candidate, userId, key))
          return { ok: true, value: entry ? { ...entry } : undefined }
        }),
      unreported: () =>
        this.enqueue(async () => {
          const loaded = await this.load()
          if (!loaded.ok) return loaded
          const waiting = loaded.value
            .filter((entry) => entry.userId === userId && entry.state === 'finished')
            .sort((a, b) => a.updatedAtUnixMs - b.updatedAtUnixMs)
          return { ok: true, value: waiting.map((entry) => ({ ...entry })) }
        })
    }
  }

  /**
   * Drops every other user's entries. Called when a different account signs in, so one account's
   * history is never visible to, or sent for, another.
   */
  purgeOthers(userId: string): Promise<Result<void>> {
    return this.enqueue(async () => {
      const loaded = await this.load()
      if (!loaded.ok) return loaded
      const kept = loaded.value.filter((entry) => entry.userId === userId)
      if (kept.length === loaded.value.length) return { ok: true, value: undefined }
      return this.write(kept, userId)
    })
  }

  private update(
    userId: string,
    key: CommandKey,
    change: (entry: JournalEntry) => JournalEntry
  ): Promise<Result<void>> {
    return this.enqueue(async () => {
      const loaded = await this.load()
      if (!loaded.ok) return loaded
      const index = loaded.value.findIndex((entry) => sameKey(entry, userId, key))
      if (index < 0)
        return { ok: false, error: { code: 'not_found', message: '명령 실행 기록이 없어요.' } }
      const next = [...loaded.value]
      next[index] = { ...change(loaded.value[index]), updatedAtUnixMs: this.options.now() }
      // The change stays in memory even if the write fails, so a command that ran is not run again
      // by this process. After a restart, an unwritten `finished` is read back as `started`.
      this.entries = next
      return this.write(next, userId)
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async load(): Promise<Result<JournalEntry[]>> {
    if (this.entries) return { ok: true, value: this.entries }
    try {
      const contents = await this.options.files.read('command-journal.json')
      if (contents === null) {
        this.entries = []
        return { ok: true, value: this.entries }
      }
      const parsed = DocumentSchema.safeParse(JSON.parse(contents))
      if (!parsed.success) return unavailable()
      // This is the first read in this run, so nothing is running: an entry still `started` was
      // cut off. It is reported as unknown and never run again.
      this.entries = parsed.data.entries.map((entry) =>
        entry.state === 'started'
          ? {
              ...entry,
              state: 'finished',
              result: interruptedResult(
                { attempt_no: entry.attemptNo },
                // A `started` entry's time is when the command began.
                { startedAtMs: entry.updatedAtUnixMs, finishedAtMs: this.options.now() }
              )
            }
          : entry
      )
      return { ok: true, value: this.entries }
    } catch {
      return unavailable()
    }
  }

  private async write(entries: JournalEntry[], activeUserId: string): Promise<Result<void>> {
    const kept = this.prune(entries, activeUserId)
    // The in-memory list is replaced only after the file is written, so a failed `begin` leaves no
    // trace and can be tried again.
    try {
      await this.options.files.replace(
        'command-journal.json',
        JSON.stringify({ version: 1, entries: kept })
      )
      this.entries = kept
      return { ok: true, value: undefined }
    } catch {
      return unavailable()
    }
  }

  private prune(entries: JournalEntry[], activeUserId: string): JournalEntry[] {
    const oldest = this.options.now() - this.retentionMs
    // Old enough that the server no longer sends the command, whatever its state.
    const fresh = entries.filter((entry) => entry.updatedAtUnixMs >= oldest)
    const own = fresh.filter((entry) => entry.userId === activeUserId)
    if (own.length <= this.maxPerUser) return fresh
    // Over the cap: drop the oldest reported entries of this user first, never unreported ones.
    const droppable = own
      .filter((entry) => entry.state === 'reported')
      .sort((a, b) => a.updatedAtUnixMs - b.updatedAtUnixMs)
      .slice(0, own.length - this.maxPerUser)
    return fresh.filter((entry) => !droppable.includes(entry))
  }
}
