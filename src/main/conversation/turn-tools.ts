import { ToolInvocationSchema, ToolNameSchema } from '../../shared/contracts/tools'
import type { ToolExecutionReport } from '../../shared/contracts/tools'
import type { LocalExecutionOptions, MonotonicClock } from '../ports'
import { describeToolReport } from '../tools/describe-report'
import type { CapabilityRegistryPort, ToolExecutorPort } from '../tools/ports'
import type { AssistantTools, ConversationNotice, ToolRequest } from './ports'

export interface TurnToolsOptions {
  executor: ToolExecutorPort
  registry: CapabilityRegistryPort
  clock: MonotonicClock
  requestId: string
  /** Aborts when the request is cancelled, times out or its conversation ends. */
  signal: AbortSignal
  notify(notice: ConversationNotice): void
  /** Most tool calls one request may make; a runaway assistant is stopped here. */
  maxCalls?: number
}

export const DEFAULT_MAX_TOOL_CALLS = 8

/**
 * The tools an assistant may use while it works on one request. Everything it asks for is checked
 * before it reaches the executor, and the executor still checks again right before acting. Once
 * `close()` is called (the request ended) or the signal aborts, nothing more is started.
 */
export class TurnTools implements AssistantTools {
  private calls = 0
  private closed = false
  /** Display names learnt from app listings during this request, for friendlier messages. */
  private readonly names = new Map<string, string>()
  private readonly reports = new Map<string, Promise<ToolExecutionReport>>()

  constructor(private readonly options: TurnToolsOptions) {}

  close(): void {
    this.closed = true
  }

  capabilities() {
    return this.options.registry.getSnapshot()
  }

  execute(request: ToolRequest): Promise<ToolExecutionReport> {
    // A repeated ID is answered with the first result and never run again.
    const known = this.reports.get(request.executionId)
    if (known) return known
    const report = this.run(request)
    this.reports.set(request.executionId, report)
    return report
  }

  private async run(request: ToolRequest): Promise<ToolExecutionReport> {
    const { requestId, signal } = this.options
    const stopped = (
      reason: 'cancelled' | 'rejected',
      code: 'cancelled' | 'invalid_input' | 'conflict',
      message: string
    ): ToolExecutionReport => this.finish(request, this.notStarted(request, reason, code, message))

    if (this.closed || signal.aborted)
      return stopped('cancelled', 'cancelled', '요청이 끝나서 실행하지 않았습니다.')
    // Every attempt counts, valid or not, so a stream of bad requests cannot go on forever.
    this.calls += 1
    if (this.calls > (this.options.maxCalls ?? DEFAULT_MAX_TOOL_CALLS))
      return stopped('rejected', 'conflict', '한 요청에서 쓸 수 있는 도구 호출 수를 넘었습니다.')
    const invocation = {
      // Different requests never share an execution ID, whatever the assistant chose.
      requestId,
      executionId: `${requestId}:${request.executionId}`,
      command: request.command
    }
    if (!ToolInvocationSchema.safeParse(invocation).success)
      return this.finish(
        request,
        this.notStarted(
          request,
          'rejected',
          'invalid_input',
          '도구 요청 형식이 올바르지 않습니다.'
        ),
        '알 수 없거나 형식이 올바르지 않은 도구 요청을 거절했어요.'
      )
    if (request.expiresInMs !== undefined && !(request.expiresInMs > 0))
      return this.finish(request, this.notStarted(request, 'expired', undefined, undefined))

    const execution: LocalExecutionOptions = {
      signal,
      ...(request.expiresInMs !== undefined
        ? { deadlineMs: this.options.clock.now() + request.expiresInMs }
        : {})
    }
    const report = await this.options.executor.execute(
      ToolInvocationSchema.parse(invocation),
      execution
    )
    if (report.outcome.status === 'observed' && report.outcome.observation.kind === 'app_list')
      for (const app of report.outcome.observation.apps) this.names.set(app.appId, app.displayName)
    return this.finish(request, report)
  }

  /** Tells the user what happened and hands the assistant the report under its own ID. */
  private finish(
    request: ToolRequest,
    report: ToolExecutionReport,
    text?: string
  ): ToolExecutionReport {
    const returned = { ...report, executionId: request.executionId }
    const summary = describeToolReport(returned, (appId) => this.names.get(appId))
    this.options.notify({
      type: 'tool',
      requestId: this.options.requestId,
      executionId: request.executionId,
      text: text ?? summary.text,
      ok: summary.ok,
      outcome: summary.outcome
    })
    return returned
  }

  private notStarted(
    request: ToolRequest,
    reason: 'cancelled' | 'expired' | 'rejected',
    code?: 'cancelled' | 'invalid_input' | 'conflict',
    message?: string
  ): ToolExecutionReport {
    const tool = toolNameOf(request.command)
    return {
      requestId: this.options.requestId,
      executionId: request.executionId,
      tool,
      outcome: {
        status: 'not_started',
        reason,
        ...(code && message ? { error: { code, message } } : {})
      },
      cancelRequested: reason === 'cancelled',
      expired: reason === 'expired'
    }
  }
}

/** The tool a request names, when it names a known one; the report needs some tool to refer to. */
function toolNameOf(command: unknown): ToolExecutionReport['tool'] {
  const tool = ToolNameSchema.safeParse((command as { tool?: unknown } | null)?.tool)
  return tool.success ? tool.data : 'apps.list'
}
