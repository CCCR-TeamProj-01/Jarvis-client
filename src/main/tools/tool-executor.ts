import type { ClientError, Result } from '../../shared/contracts/common'
import { ToolInvocationSchema, ToolNameSchema } from '../../shared/contracts/tools'
import type {
  CancelExecutionResult,
  Capability,
  ToolExecutionReport,
  ToolInvocation,
  ToolName,
  ToolOutcome,
  WindowReference
} from '../../shared/contracts/tools'
import type { AppControlPort, FolderOpenPort, SystemAudioPort } from '../platform/ports'
import type { LocalExecutionOptions, MonotonicClock } from '../ports'
import type { CapabilityRegistryPort, ToolExecutorPort } from './ports'

interface ToolExecutorOptions {
  registry: CapabilityRegistryPort
  appControl: AppControlPort
  /** Main's own authentication state, read again right before anything runs. */
  folders: FolderOpenPort
  audio: SystemAudioPort
  auth: { requireSignedIn(): Result<unknown> }
  clock: MonotonicClock
  /** Where "go back" returns to; null when no earlier work was recorded. */
  restoreTarget(): WindowReference | null
  /** How many finished executions are remembered for duplicate detection. */
  maxFinished?: number
}

/** Only the tools that change the desktop are queued; reading the app list is not. */
const SIDE_EFFECT_TOOLS: ReadonlySet<ToolName> = new Set([
  'apps.launch',
  'apps.activate',
  'apps.restore',
  'browser.open',
  'folder.open',
  'system.volume',
  'system.mute'
])

/** Failures after which nothing on the desktop has happened. */
const NO_EFFECT_CODES: ReadonlySet<ClientError['code']> = new Set([
  'not_found',
  'invalid_input',
  'permission_denied',
  'unsupported',
  'authentication_required',
  'unavailable',
  'conflict',
  'cancelled'
])

type Observation = Extract<ToolOutcome, { status: 'observed' }>['observation']

interface Entry {
  /** Canonical form of the command, to tell a repeated request from a reused ID. */
  key: string
  tool: ToolName
  report: Promise<ToolExecutionReport>
  state: 'queued' | 'running' | 'finished'
  abort: AbortController
  cancelRequested: boolean
}

/**
 * Validates, deduplicates, orders and reports tool executions. A request that never started is
 * reported as such; a request that may have acted is never run a second time, and uncertainty is
 * reported as `unknown` rather than guessed.
 */
export class ToolExecutor implements ToolExecutorPort {
  private readonly entries = new Map<string, Entry>()
  /** Side-effecting tools run one after another so launches and focus changes cannot interleave. */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: ToolExecutorOptions) {}

  async execute(
    invocation: ToolInvocation,
    options?: LocalExecutionOptions
  ): Promise<ToolExecutionReport> {
    const parsed = ToolInvocationSchema.safeParse(invocation)
    // Connection code validates first; this guards direct callers and reports what it can.
    if (!parsed.success) return this.malformed(invocation)
    const { requestId, executionId, command } = parsed.data
    const tool = command.tool
    const key = JSON.stringify(command)

    const existing = this.entries.get(executionId)
    if (existing) {
      if (existing.key !== key)
        return notStarted(requestId, executionId, tool, 'rejected', {
          code: 'conflict',
          message: '같은 실행 ID로 다른 요청이 들어왔습니다.'
        })
      return existing.report
    }

    const rejected = this.recheck(tool)
    if (rejected) return notStarted(requestId, executionId, tool, 'rejected', rejected)

    const entry: Entry = {
      key,
      tool,
      state: 'queued',
      abort: new AbortController(),
      cancelRequested: false,
      report: undefined as unknown as Promise<ToolExecutionReport>
    }
    const forwardAbort = () => this.requestCancel(entry)
    if (options?.signal?.aborted) forwardAbort()
    else options?.signal?.addEventListener('abort', forwardAbort, { once: true })

    entry.report = this.schedule(entry, parsed.data, options).finally(() => {
      options?.signal?.removeEventListener('abort', forwardAbort)
      entry.state = 'finished'
      this.prune()
    })
    this.entries.set(executionId, entry)
    return entry.report
  }

  async cancel(executionId: string): Promise<Result<CancelExecutionResult>> {
    const entry = this.entries.get(executionId)
    if (!entry) return { ok: true, value: 'not_found' }
    if (entry.state === 'finished') return { ok: true, value: 'already_finished' }
    const queued = entry.state === 'queued'
    this.requestCancel(entry)
    return { ok: true, value: queued ? 'prevented_start' : 'requested' }
  }

  /**
   * The signed-in user changed. In-flight work is cancelled and nothing about the previous user's
   * executions is kept, so a repeated ID from the new session can never replay their results.
   */
  resetForNewSession(): void {
    for (const entry of this.entries.values()) this.requestCancel(entry)
    this.entries.clear()
  }

  // --- scheduling ------------------------------------------------------------------------------

  private schedule(
    entry: Entry,
    invocation: ToolInvocation,
    options?: LocalExecutionOptions
  ): Promise<ToolExecutionReport> {
    const run = () => this.run(entry, invocation, options)
    if (!SIDE_EFFECT_TOOLS.has(entry.tool)) return run()
    // A failed predecessor must not block the queue; `run` never rejects.
    const next = this.tail.then(run, run)
    this.tail = next
    return next
  }

  private async run(
    entry: Entry,
    invocation: ToolInvocation,
    options?: LocalExecutionOptions
  ): Promise<ToolExecutionReport> {
    const { requestId, executionId, command } = invocation
    const tool = command.tool
    const report = (outcome: ToolOutcome): ToolExecutionReport => ({
      requestId,
      executionId,
      tool,
      outcome,
      cancelRequested: entry.cancelRequested,
      expired: this.expired(options)
    })
    const stop = (reason: 'cancelled' | 'expired' | 'rejected', error?: ClientError) =>
      report({ status: 'not_started', reason, ...(error ? { error } : {}) })

    // Last checks before anything touches the desktop; time may have passed in the queue.
    if (entry.abort.signal.aborted) return stop('cancelled')
    if (this.expired(options)) return stop('expired')
    const rejected = this.recheck(tool)
    if (rejected) return stop('rejected', rejected)

    entry.state = 'running'
    const execution = { signal: entry.abort.signal, deadlineMs: options?.deadlineMs }
    try {
      const outcome = await this.dispatch(command, execution)
      // Cancelled before the adapter acted: nothing happened.
      if (!outcome.ok && entry.abort.signal.aborted && outcome.error.code === 'cancelled')
        return stop('cancelled')
      return report(
        outcome.ok
          ? { status: 'observed', observation: outcome.value }
          : {
              status: 'failed',
              error: outcome.error,
              effect: NO_EFFECT_CODES.has(outcome.error.code) ? 'none' : 'possible'
            }
      )
    } catch {
      // The adapter broke its contract. Whether anything happened is genuinely unknown, and the
      // same execution ID must not run again.
      return report({ status: 'unknown', reason: '실행 결과를 확인하지 못했습니다.' })
    }
  }

  private async dispatch(
    command: ToolInvocation['command'],
    execution: LocalExecutionOptions
  ): Promise<Result<Observation>> {
    const { appControl } = this.options
    switch (command.tool) {
      case 'apps.list': {
        const result = await appControl.list(execution)
        return result.ok ? { ok: true, value: { kind: 'app_list', apps: result.value } } : result
      }
      case 'apps.launch':
        return appControl.launch(command.arguments.appId, execution)
      case 'apps.activate':
        return appControl.activate(command.arguments.appId, execution)
      case 'apps.restore': {
        const target = this.options.restoreTarget()
        if (!target)
          return {
            ok: false,
            error: { code: 'not_found', message: '돌아갈 이전 작업이 기록되어 있지 않습니다.' }
          }
        return appControl.restore(target, execution)
      }
      case 'browser.open':
        return appControl.openUrl(command.arguments.url, execution)
      case 'folder.open':
        return this.options.folders.open(command.arguments.alias, execution)
      case 'system.volume':
        return command.arguments.mode === 'set'
          ? this.options.audio.setVolume(command.arguments.level, execution)
          : this.options.audio.adjustVolume(command.arguments.delta, execution)
      case 'system.mute':
        return this.options.audio.setMuted(command.arguments.muted, execution)
    }
  }

  // --- helpers ---------------------------------------------------------------------------------

  /** Authentication and capability, read at the moment of use rather than trusted from earlier. */
  private recheck(tool: ToolName): ClientError | null {
    const signedIn = this.options.auth.requireSignedIn()
    if (!signedIn.ok) return signedIn.error
    const capability = this.options.registry
      .getSnapshot()
      .capabilities.find((candidate: Capability) => candidate.tool === tool)
    if (!capability || capability.availability === 'unsupported')
      return {
        code: 'unsupported',
        message: capability?.reason ?? '이 기기에서 지원하지 않는 도구입니다.'
      }
    if (capability.availability === 'permission_required')
      return { code: 'permission_denied', message: capability.reason ?? '권한이 필요합니다.' }
    if (capability.availability === 'unavailable')
      return { code: 'unavailable', message: capability.reason ?? '지금은 사용할 수 없습니다.' }
    return null
  }

  private expired(options?: LocalExecutionOptions): boolean {
    return options?.deadlineMs !== undefined && options.deadlineMs <= this.options.clock.now()
  }

  private requestCancel(entry: Entry): void {
    entry.cancelRequested = true
    entry.abort.abort()
  }

  /** Keep recent finished executions for duplicate detection without growing without bound. */
  private prune(): void {
    const limit = this.options.maxFinished ?? 500
    const finished = [...this.entries].filter(([, entry]) => entry.state === 'finished')
    for (const [id] of finished.slice(0, Math.max(0, finished.length - limit)))
      this.entries.delete(id)
  }

  private malformed(invocation: unknown): ToolExecutionReport {
    const raw = invocation as {
      requestId?: unknown
      executionId?: unknown
      command?: { tool?: unknown }
    }
    const id = (value: unknown) =>
      typeof value === 'string' && value.trim() === value && value ? value : 'invalid'
    const tool = ToolNameSchema.safeParse(raw?.command?.tool)
    return notStarted(
      id(raw?.requestId),
      id(raw?.executionId),
      tool.success ? tool.data : 'apps.list',
      'rejected',
      {
        code: 'invalid_input',
        message: '도구 요청 형식이 올바르지 않습니다.'
      }
    )
  }
}

function notStarted(
  requestId: string,
  executionId: string,
  tool: ToolName,
  reason: 'cancelled' | 'expired' | 'rejected',
  error?: ClientError
): ToolExecutionReport {
  return {
    requestId,
    executionId,
    tool,
    outcome: { status: 'not_started', reason, ...(error ? { error } : {}) },
    cancelRequested: false,
    expired: false
  }
}
