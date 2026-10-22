import type { ClientError } from '../../shared/contracts/common'
import type { ToolExecutionReport, ToolName } from '../../shared/contracts/tools'
import { appCodeFor, appDisplayNameFor } from './app-codes'
import type { AppCode } from './app-codes'
import { CommandResultSchema } from './command-result'
import type { CommandRejection, CommandResult, CommandTiming } from './command-result'
import type { ServerCommand } from './server-command'

type ResultErrorCode = NonNullable<CommandResult['error_code']>
type FailureStage = NonNullable<CommandResult['failure_stage']>

export interface ResultContext {
  platform: NodeJS.Platform
  timing: CommandTiming
  /** The app the server named, when the command was about one. */
  app?: { appCode: AppCode; osAppId: string }
  /** The name the OS shows for an app, if known. */
  displayName?: (osAppId: string) => string | undefined
}

/** What the server is told, in words. Fixed text only: no URLs, paths, volume values or OS errors. */
const TOOL_LABEL: Record<ToolName, string> = {
  'apps.list': '앱 목록 확인',
  'apps.launch': '앱 실행',
  'apps.activate': '앱 전환',
  'apps.restore': '이전 작업으로 돌아가기',
  'browser.open': '주소 열기',
  'folder.open': '폴더 열기',
  'system.volume': '볼륨 조절',
  'system.mute': '음소거'
}

/**
 * The three times of a result. The report time is the finish time: it is fixed here once, because
 * a result sent again must be identical to the first (the server compares them).
 */
function timesOf(timing: CommandTiming) {
  const finished = Math.max(timing.finishedAtMs, timing.startedAtMs)
  const iso = (ms: number) => new Date(ms).toISOString()
  return {
    started_at: iso(timing.startedAtMs),
    finished_at: iso(finished),
    reported_at: iso(finished)
  }
}

/** A command that was refused before it reached a tool. */
export function rejectedResult(
  command: Pick<ServerCommand, 'attempt_no'>,
  rejection: CommandRejection,
  timing: CommandTiming
): CommandResult {
  return CommandResultSchema.parse({
    ...timesOf(timing),
    attempt_no: command.attempt_no,
    status: 'rejected',
    observation_status: 'not_applicable',
    error_code: rejection.errorCode,
    failure_stage: rejection.failureStage,
    result_message: rejection.message
  })
}

/** A command that arrived too late to be worth running; nothing was run. */
export function expiredResult(
  command: Pick<ServerCommand, 'attempt_no'>,
  timing: CommandTiming
): CommandResult {
  return CommandResultSchema.parse({
    ...timesOf(timing),
    attempt_no: command.attempt_no,
    status: 'failed',
    observation_status: 'not_applicable',
    error_code: 'expired',
    failure_stage: 'timeout',
    result_message: '요청 시간이 지나 실행하지 않았어요.'
  })
}

/**
 * The result for a command that was started but whose outcome was lost, for example because the
 * app ended while it ran. Nothing is claimed, and the command is never run again.
 */
export function interruptedResult(
  command: Pick<ServerCommand, 'attempt_no'>,
  timing: CommandTiming
): CommandResult {
  return CommandResultSchema.parse({
    ...timesOf(timing),
    attempt_no: command.attempt_no,
    status: 'unknown',
    observation_status: 'unknown',
    error_code: 'unknown',
    result_message: '명령이 실행됐는지 확인하지 못했어요.'
  })
}

/** The server's result for a local execution report. */
export function resultFromReport(
  command: Pick<ServerCommand, 'attempt_no'>,
  report: ToolExecutionReport,
  context: ResultContext
): CommandResult {
  const label = TOOL_LABEL[report.tool]
  const outcome = report.outcome
  const base = { attempt_no: command.attempt_no, ...timesOf(context.timing) }

  switch (outcome.status) {
    case 'observed': {
      const observation = outcome.observation
      const observationStatus =
        observation.kind === 'app_list' ? 'not_applicable' : observation.status
      const app = appOf(observation, context)
      return CommandResultSchema.parse({
        ...base,
        status: 'success',
        observation_status: observationStatus,
        result_message:
          observationStatus === 'confirmed'
            ? `${label}을(를) 마쳤어요.`
            : `${label}을(를) 요청했어요. 결과는 확인하지 못했어요.`,
        ...(app ? { app } : {})
      })
    }
    case 'unknown':
      return CommandResultSchema.parse({
        ...base,
        status: 'unknown',
        observation_status: 'unknown',
        // No stage: the server accepts one only on a failed or rejected result.
        error_code: 'unknown',
        result_message: `${label}이(가) 실행됐는지 확인하지 못했어요.`
      })
    case 'failed': {
      const possible = outcome.effect === 'possible'
      return CommandResultSchema.parse({
        ...base,
        status: 'failed',
        observation_status: possible ? 'unknown' : 'not_applicable',
        error_code: errorCodeOf(outcome.error),
        failure_stage: stageOfFailure(outcome.error, possible),
        result_message: `${label}에 실패했어요.`
      })
    }
    case 'not_started': {
      if (outcome.reason === 'cancelled')
        return notStarted(base, 'failed', 'cancelled', 'cancellation', `${label}이(가) 취소됐어요.`)
      if (outcome.reason === 'expired')
        return notStarted(
          base,
          'failed',
          'expired',
          'timeout',
          `${label} 요청 시간이 지나 실행하지 않았어요.`
        )
      const error = outcome.error
      // The same execution ID with a different request is a client-side inconsistency.
      if (error?.code === 'conflict')
        return notStarted(
          base,
          'failed',
          'internal',
          'internal',
          `${label}을(를) 실행하지 못했어요.`
        )
      const invalid = error?.code === 'invalid_input'
      return notStarted(
        base,
        'rejected',
        invalid ? 'invalid_input' : errorCodeOf(error),
        invalid ? 'validation' : 'capability',
        `${label}을(를) 이 기기에서 실행할 수 없어요.`
      )
    }
  }
}

function notStarted(
  base: Pick<CommandResult, 'attempt_no' | 'started_at' | 'finished_at' | 'reported_at'>,
  status: 'failed' | 'rejected',
  errorCode: ResultErrorCode,
  stage: FailureStage,
  message: string
): CommandResult {
  return CommandResultSchema.parse({
    ...base,
    status,
    observation_status: 'not_applicable',
    error_code: errorCode,
    failure_stage: stage,
    result_message: message
  })
}

function appOf(
  observation: Extract<ToolExecutionReport['outcome'], { status: 'observed' }>['observation'],
  context: ResultContext
): CommandResult['app'] {
  if (observation.kind !== 'app') return undefined
  // A restore names no code; the app is reported only when it is one of the server's fixed set.
  const code =
    context.app?.osAppId === observation.appId
      ? context.app.appCode
      : appCodeFor(observation.appId, context.platform)
  if (!code) return undefined
  return {
    app_code: code,
    os_app_id: observation.appId,
    display_name:
      context.displayName?.(observation.appId) ??
      appDisplayNameFor(code, context.platform) ??
      observation.appId
  }
}

/** The client's error codes as the small set the server is sent. */
function errorCodeOf(error: ClientError | undefined): ResultErrorCode {
  switch (error?.code) {
    case 'invalid_input':
    case 'not_found':
    case 'cancelled':
    case 'expired':
    case 'unavailable':
    case 'unsupported':
    case 'permission_denied':
      return error.code
    case 'authentication_required':
    case 'session_expired':
    case 'invalid_credentials':
      return 'permission_denied'
    default:
      return 'internal'
  }
}

/** Where in the run a failure happened. A failure that may have acted is an execution failure. */
function stageOfFailure(error: ClientError, effectPossible: boolean): FailureStage {
  switch (errorCodeOf(error)) {
    case 'invalid_input':
      return 'validation'
    case 'unsupported':
    case 'permission_denied':
      return 'capability'
    case 'not_found':
      return 'precondition'
    case 'cancelled':
      return 'cancellation'
    case 'expired':
      return 'timeout'
    case 'unavailable':
      return effectPossible ? 'execution' : 'dispatch'
    default:
      return effectPossible ? 'execution' : 'internal'
  }
}
