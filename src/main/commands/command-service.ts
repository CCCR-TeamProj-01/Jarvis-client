import type { Result } from '../../shared/contracts/common'
import type { ResultOutcome } from '../../shared/contracts/interaction'
import type { ToolExecutionReport, ToolInvocation } from '../../shared/contracts/tools'
import type { LocalExecutionOptions } from '../ports'
import type { ServerClock } from '../connection/server-clock'
import {
  activityEventType,
  activityFor,
  resultForSending,
  runningAppCodes,
  usesApp
} from './activity'
import type { CollectionConsent } from './activity'
import type { CollectionConsentPort } from './collection-consent'
import { describeToolReport } from '../tools/describe-report'
import type { ReportSummary } from '../tools/describe-report'
import type { CommandApiPort, PendingItem } from './command-api'
import type { CommandJournal, JournalEntry } from './command-journal'
import { CommandResultSchema } from './command-result'
import type { CommandResult } from './command-result'
import { summarizeUnrun } from './result-summary'
import { invocationFor, translateCommand } from './command-translator'
import { expiredResult, interruptedResult, rejectedResult, resultFromReport } from './result-mapper'
import type { ServerCommand } from './server-command'

/** What became of a command, in the words shown to the user. */
export interface CommandFinished {
  commandId: string
  attemptNo: number
  text: string
  ok: boolean
  outcome: ResultOutcome
}

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
  /**
   * A command just finished (or was refused) on this computer. Called once per command, when it is
   * done: not for one the journal had already seen, and not once the service was stopped.
   */
  onFinished?(finished: CommandFinished): void
  /**
   * What is told the server about the apps used, for the history and recommendations. Left out:
   * no activity is ever reported.
   */
  activity?: {
    consent: CollectionConsentPort
    /** The OS app IDs of the apps running now. */
    runningApps(signal?: AbortSignal): Promise<Result<readonly string[]>>
    /** A new ID that has not been used before. */
    createId(): string
  }
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
/** A consent just read is trusted this long when a result is sent; before running, it is always read afresh. */
const CONSENT_REUSE_MS = 30_000

/**
 * Receives the device's commands, runs each once and reports the result. One command is handled
 * at a time and in the order the server gave; a failed command does not stop the ones after it.
 * Nothing runs unless the journal has recorded that it is about to, and a command the journal has
 * already seen is never run again; only its stored result is sent.
 */
export class CommandService {
  private run: { userId: string; abort: AbortController; done: Promise<void> } | null = null
  private consent: { userId: string; value: CollectionConsent; atMs: number } | null = null

  constructor(private readonly options: CommandServiceOptions) {}

  /** Starts receiving for a signed-in user. Calling it again for the same user does nothing. */
  start(userId: string): void {
    if (this.run?.userId === userId) return
    // Stopping also forgets the consent held for the earlier user.
    void this.stop()
    const abort = new AbortController()
    const done = this.loop(userId, abort.signal).catch(() =>
      this.log('명령 처리를 계속하지 못했어요.')
    )
    this.run = { userId, abort, done }
  }

  /** The user's consent may have changed: the one held is dropped, so the next result reads it again. */
  forgetConsent(): void {
    this.consent = null
  }

  /**
   * Stops receiving and cancels what is running; resolves when the loop has ended. Results not yet
   * sent stay in the journal.
   */
  stop(): Promise<void> {
    const run = this.run
    this.run = null
    this.consent = null
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
    const body = await this.bodyToSend(userId, entry.result, signal)
    const outcome = await this.options.api.send(entry.commandId, body, signal)
    if (outcome.kind === 'retry') return false
    if (outcome.kind === 'stored' && body.activity && outcome.activityRecorded === false)
      this.log('서버가 앱 사용 기록을 저장하지 않았어요. 명령 결과는 저장됐어요.')
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

    const { result, summary } = await this.resultFor(userId, item, startedAtMs, signal)
    const finished = await journal.finish(key, result)
    if (!finished.ok) this.log('명령 결과를 기록하지 못했어요.')
    if (signal.aborted) return 'done'
    this.announce(key, summary)
    const entry = await journal.get(key)
    if (entry.ok && entry.value?.state === 'finished')
      await this.deliver(userId, entry.value, signal)
    return 'done'
  }

  /** Tells whoever shows results that this command is done. A listener's failure is no one else's. */
  private announce(key: { commandId: string; attemptNo: number }, summary: ReportSummary): void {
    try {
      this.options.onFinished?.({ ...key, ...summary })
    } catch {
      this.log('명령 결과를 화면에 알리지 못했어요.')
    }
  }

  private async resultFor(
    userId: string,
    item: PendingItem,
    startedAtMs: number,
    signal: AbortSignal
  ): Promise<{ result: CommandResult; summary: ReportSummary }> {
    const timingNow = () => ({ startedAtMs, finishedAtMs: this.options.now() })
    /** A command that did not run: its result and the words for it. */
    const unrun = (commandType: string | null, result: CommandResult) => ({
      result,
      summary: summarizeUnrun(commandType, result)
    })
    if (item.kind === 'malformed')
      return unrun(
        null,
        rejectedResult(
          { attempt_no: item.attemptNo },
          {
            failureStage: 'validation',
            errorCode: 'invalid_input',
            message: '명령의 형식이 올바르지 않아 실행하지 않았어요.'
          },
          timingNow()
        )
      )
    const command = item.command
    if (this.isExpired(command))
      return unrun(command.command_type, expiredResult(command, timingNow()))

    const translated = translateCommand(command, this.options.platform)
    if (!translated.ok)
      return unrun(command.command_type, rejectedResult(command, translated.rejection, timingNow()))

    // What the user allowed is read before anything runs, and nothing is looked at without it.
    const tool = translated.value.command.tool
    const watching = this.options.activity !== undefined && usesApp(tool)
    const consent = watching ? await this.consentFor(userId, signal, 0) : null
    const runningBefore =
      consent?.activityEnabled && tool === 'apps.launch' ? await this.runningApps(signal) : null

    let report: ToolExecutionReport
    try {
      report = await this.options.executor.execute(
        invocationFor(command, translated.value.command),
        { signal }
      )
    } catch {
      // The executor reports rather than throws. If it did, the command may have acted.
      return unrun(command.command_type, interruptedResult(command, timingNow()))
    }
    // The times are fixed here: what is read afterwards must not move them.
    const result = resultFromReport(command, report, {
      platform: this.options.platform,
      timing: timingNow(),
      app: translated.value.app,
      displayName: this.options.displayName
    })
    return {
      result: consent
        ? await this.withActivity(report, result, consent, runningBefore, signal)
        : result,
      summary: describeToolReport(report, this.options.displayName)
    }
  }

  /** The result with the activity it called for, if any. Failing to take the list never changes the result. */
  private async withActivity(
    report: ToolExecutionReport,
    result: CommandResult,
    consent: CollectionConsent,
    runningBefore: string[] | null,
    signal: AbortSignal
  ): Promise<CommandResult> {
    const activity = this.options.activity
    if (!activity) return result
    const before = runningBefore === null ? null : new Set(runningBefore)
    // Whether this calls for an activity is settled first, so no list is taken for nothing.
    if (activityEventType({ tool: report.tool, result, consent, runningBefore: before }) === null)
      return result
    let runningNow: ReturnType<typeof runningAppCodes> | null = null
    if (consent.externalEnabled) {
      const apps = await this.runningApps(signal)
      if (apps !== null) runningNow = runningAppCodes(apps, this.options.platform)
    }
    const made = activityFor({
      tool: report.tool,
      result,
      consent,
      runningBefore: before,
      runningNow,
      eventKey: activity.createId()
    })
    const parsed = made ? CommandResultSchema.safeParse({ ...result, activity: made }) : null
    return parsed?.success ? parsed.data : result
  }

  /** The OS IDs of the apps running now, or null when they cannot be read. */
  private async runningApps(signal: AbortSignal): Promise<string[] | null> {
    try {
      const apps = await this.options.activity?.runningApps(signal)
      return apps?.ok ? [...apps.value] : null
    } catch {
      return null
    }
  }

  /** The user's consent: freshly read unless one read within `maxAgeMs` is held; null when it cannot be told. */
  private async consentFor(
    userId: string,
    signal: AbortSignal,
    maxAgeMs: number
  ): Promise<CollectionConsent | null> {
    const source = this.options.activity?.consent
    if (!source) return null
    const held = this.consent
    if (held && held.userId === userId && this.options.now() - held.atMs < maxAgeMs)
      return held.value
    try {
      const read = await source.read(signal)
      if (!read.ok) {
        this.consent = null
        return null
      }
      this.consent = { userId, value: read.value, atMs: this.options.now() }
      return read.value
    } catch {
      this.consent = null
      return null
    }
  }

  /** The stored result as it goes out now: the activity is dropped or trimmed to what is still allowed. */
  private async bodyToSend(
    userId: string,
    result: CommandResult,
    signal: AbortSignal
  ): Promise<CommandResult> {
    if (!result.activity) return result
    const consent = await this.consentFor(userId, signal, CONSENT_REUSE_MS)
    return resultForSending(result, consent)
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
