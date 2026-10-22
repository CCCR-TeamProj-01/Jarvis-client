import type { ToolExecutionReport, ToolInvocation } from '../../shared/contracts/tools'
import type { LocalExecutionOptions } from '../ports'
import type { ServerClock } from '../connection/server-clock'
import type { CommandApiPort, PendingItem } from './command-api'
import type { CommandJournal, JournalEntry } from './command-journal'
import type { CommandResult } from './command-result'
import { invocationFor, translateCommand } from './command-translator'
import { expiredResult, interruptedResult, rejectedResult, resultFromReport } from './result-mapper'
import type { ServerCommand } from './server-command'

export interface CommandServiceOptions {
  api: CommandApiPort
  journal: CommandJournal
  executor: {
    execute(
      invocation: ToolInvocation,
      options?: LocalExecutionOptions
    ): Promise<ToolExecutionReport>
  }
  platform: NodeJS.Platform
  /** Wall-clock milliseconds. */
  now(): number
  /** Learned from the server's responses; corrects `requested_at` for a wrong local clock. */
  clock: Pick<ServerClock, 'serverTimeAt'>
  /** Resolves after `ms`, or early when the signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
  displayName?(osAppId: string): string | undefined
  /** Fixed wording only: never a command's contents. */
  log?(message: string): void
  /** A command older than this when it arrives is not started. */
  expiryMs?: number
}

const DEFAULT_EXPIRY_MS = 60_000
const PAGE_SIZE = 10
const DEFAULT_POLL_MS = 2_000
const MIN_POLL_MS = 1_000
const MAX_POLL_MS = 30_000
const MAX_RETRY_AFTER_MS = 60_000

/**
 * Receives the device's commands, runs each once and reports the result. One command is handled
 * at a time and in the order the server gave; a failed command does not stop the ones after it.
 * Nothing runs unless the journal has recorded that it is about to, and a command the journal has
 * already seen is never run again; only its stored result is sent.
 */
export class CommandService {
  private run: { userId: string; abort: AbortController; done: Promise<void> } | null = null

  constructor(private readonly options: CommandServiceOptions) {}

  /** Starts receiving for a signed-in user. Calling it again for the same user does nothing. */
  start(userId: string): void {
    if (this.run?.userId === userId) return
    void this.stop()
    const abort = new AbortController()
    const done = this.loop(userId, abort.signal).catch(() =>
      this.log('명령 처리를 계속하지 못했어요.')
    )
    this.run = { userId, abort, done }
  }

  /**
   * Stops receiving and cancels what is running; resolves when the loop has ended. Results not yet
   * sent stay in the journal.
   */
  stop(): Promise<void> {
    const run = this.run
    this.run = null
    run?.abort.abort()
    return run?.done ?? Promise.resolve()
  }

  /** One round: send what is waiting, ask for new commands, handle them. Returns the wait before the next. */
  async cycle(userId: string, signal: AbortSignal): Promise<{ waitMs: number; failed: boolean }> {
    const flushed = await this.flush(userId, signal)
    const page = await this.options.api.pending(PAGE_SIZE, signal)
    if (!page.ok) return { waitMs: page.retryAfterMs ?? 0, failed: true }
    let failed = flushed.failed
    for (const item of page.value.items) {
      if (signal.aborted) break
      const outcome = await this.handle(userId, item, signal)
      if (outcome === 'journal_unavailable') {
        // Without the journal nothing may run. The items stay pending on the server.
        failed = true
        break
      }
    }
    const asked = page.value.pollAfterMs ?? DEFAULT_POLL_MS
    return { waitMs: Math.min(Math.max(asked, MIN_POLL_MS), MAX_POLL_MS), failed }
  }

  private async loop(userId: string, signal: AbortSignal): Promise<void> {
    // A different account's history is dropped before this one's first command.
    await this.options.journal.purgeOthers(userId)
    let failures = 0
    while (!signal.aborted) {
      const { waitMs, failed } = await this.cycle(userId, signal)
      failures = failed ? failures + 1 : 0
      const backoff =
        failures === 0 ? 0 : Math.min(DEFAULT_POLL_MS * 2 ** (failures - 1), MAX_POLL_MS)
      await this.options.sleep(
        Math.min(Math.max(waitMs, backoff), failures > 0 ? MAX_RETRY_AFTER_MS : MAX_POLL_MS),
        signal
      )
    }
  }

  /** Sends every result that is waiting, oldest first. Stops at the first one that cannot be sent. */
  private async flush(userId: string, signal: AbortSignal): Promise<{ failed: boolean }> {
    const waiting = await this.options.journal.forUser(userId).unreported()
    if (!waiting.ok) return { failed: true }
    for (const entry of waiting.value) {
      if (signal.aborted) return { failed: false }
      if (!(await this.deliver(userId, entry, signal))) return { failed: true }
    }
    return { failed: false }
  }

  /** True when the result no longer needs sending (stored, or the server will never take it). */
  private async deliver(
    userId: string,
    entry: JournalEntry,
    signal: AbortSignal
  ): Promise<boolean> {
    if (!entry.result) return true
    const outcome = await this.options.api.send(entry.commandId, entry.result, signal)
    if (outcome.kind === 'retry') return false
    if (outcome.kind === 'refused') this.log('서버가 명령 결과를 받지 않아 더 보내지 않아요.')
    await this.options.journal
      .forUser(userId)
      .markReported({ commandId: entry.commandId, attemptNo: entry.attemptNo })
    return true
  }

  private async handle(
    userId: string,
    item: PendingItem,
    signal: AbortSignal
  ): Promise<'done' | 'skipped' | 'journal_unavailable'> {
    const commandId = item.kind === 'command' ? item.command.command_id : item.commandId
    const attemptNo = item.kind === 'command' ? item.command.attempt_no : item.attemptNo
    const key = { commandId, attemptNo }
    const journal = this.options.journal.forUser(userId)

    const startedAtMs = this.options.now()
    const begun = await journal.begin(key)
    if (!begun.ok) {
      this.log('명령 실행 기록을 쓸 수 없어 명령을 실행하지 않았어요.')
      return 'journal_unavailable'
    }
    // Seen before: it is never run again, and a result still waiting is sent now.
    if (begun.value.kind === 'existing') {
      const known = begun.value.entry
      if (known.state === 'finished' && !signal.aborted) await this.deliver(userId, known, signal)
      return 'skipped'
    }

    const result = await this.resultFor(item, startedAtMs, signal)
    const finished = await journal.finish(key, result)
    if (!finished.ok) this.log('명령 결과를 기록하지 못했어요.')
    if (signal.aborted) return 'done'
    const entry = await journal.get(key)
    if (entry.ok && entry.value?.state === 'finished')
      await this.deliver(userId, entry.value, signal)
    return 'done'
  }

  private async resultFor(
    item: PendingItem,
    startedAtMs: number,
    signal: AbortSignal
  ): Promise<CommandResult> {
    const timingNow = () => ({ startedAtMs, finishedAtMs: this.options.now() })
    if (item.kind === 'malformed')
      return rejectedResult(
        { attempt_no: item.attemptNo },
        {
          failureStage: 'validation',
          errorCode: 'invalid_input',
          message: '명령의 형식이 올바르지 않아 실행하지 않았어요.'
        },
        timingNow()
      )
    const command = item.command
    if (this.isExpired(command)) return expiredResult(command, timingNow())

    const translated = translateCommand(command, this.options.platform)
    if (!translated.ok) return rejectedResult(command, translated.rejection, timingNow())

    let report: ToolExecutionReport
    try {
      report = await this.options.executor.execute(
        invocationFor(command, translated.value.command),
        { signal }
      )
    } catch {
      // The executor reports rather than throws. If it did, the command may have acted.
      return interruptedResult(command, timingNow())
    }
    return resultFromReport(command, report, {
      platform: this.options.platform,
      timing: timingNow(),
      app: translated.value.app,
      displayName: this.options.displayName
    })
  }

  /** Judged on the server's clock: `requested_at` is a server time. */
  private isExpired(command: ServerCommand): boolean {
    const requested = Date.parse(command.requested_at)
    const local = this.options.now()
    const serverNow = this.options.clock.serverTimeAt(local) ?? local
    return serverNow - requested > (this.options.expiryMs ?? DEFAULT_EXPIRY_MS)
  }

  private log(message: string): void {
    this.options.log?.(message)
  }
}
