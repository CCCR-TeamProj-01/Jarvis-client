import type { ResultOutcome } from '../../shared/contracts/interaction'
import type {
  AudioObservation,
  FolderAlias,
  ToolExecutionReport
} from '../../shared/contracts/tools'

/**
 * What a report means to the user, in words. `outcome` says how far it is known to have gone:
 * `success` (seen to happen), `requested` (handed over, not seen), `unknown` (could not be told) or
 * `failure`. `ok` is the coarser yes/no kept for the status pill: handed over counts as yes.
 */
export interface ReportSummary {
  text: string
  ok: boolean
  outcome: ResultOutcome
}

type Status = 'confirmed' | 'dispatched' | 'unknown'

/** How far an observation went. */
const outcomeOf = (status: Status): ResultOutcome =>
  status === 'confirmed' ? 'success' : status === 'dispatched' ? 'requested' : 'unknown'

const summary = (outcome: ResultOutcome, text: string): ReportSummary => ({
  text,
  outcome,
  ok: outcome === 'success' || outcome === 'requested'
})

/** A short name for an app ID such as `com.apple.Safari` when no display name is known. */
function shortName(appId: string): string {
  const last = appId
    .split(/[./\\]/)
    .filter(Boolean)
    .pop()
  return last && last.length > 0 ? last : appId
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '주소'
  }
}

const TOOL_LABEL: Record<ToolExecutionReport['tool'], string> = {
  'apps.list': '앱 목록 확인',
  'apps.launch': '앱 실행',
  'apps.activate': '앱 전환',
  'apps.restore': '이전 작업으로 돌아가기',
  'browser.open': '주소 열기',
  'folder.open': '폴더 열기',
  'system.volume': '볼륨 조절',
  'system.mute': '음소거'
}

const FOLDER_LABEL: Record<FolderAlias, string> = {
  home: '홈',
  desktop: '바탕 화면',
  documents: '문서',
  downloads: '다운로드',
  pictures: '사진',
  music: '음악',
  videos: '동영상'
}

/**
 * The user-facing sentence for what happened. It states only what the report proves: a handed-over
 * request is "requested", not "done", and an uncertain result says so. Paths and raw error details
 * never appear, only the report's own messages.
 */
export function describeToolReport(
  report: ToolExecutionReport,
  displayName: (appId: string) => string | undefined = () => undefined
): ReportSummary {
  const name = (appId: string) => displayName(appId) ?? shortName(appId)
  const { outcome } = report
  switch (outcome.status) {
    case 'observed': {
      const observation = outcome.observation
      if (observation.kind === 'app_list')
        return summary('success', `앱 ${observation.apps.length}개를 확인했어요.`)
      if (observation.kind === 'url')
        return summary(
          outcomeOf(observation.status),
          observation.status === 'dispatched'
            ? `${hostOf(observation.url)} 주소를 브라우저로 전달했어요.`
            : `${hostOf(observation.url)} 주소를 열었는지 확인하지 못했어요.`
        )
      if (observation.kind === 'folder')
        return summary(
          outcomeOf(observation.status),
          observation.status === 'dispatched'
            ? `${FOLDER_LABEL[observation.alias]} 폴더를 열도록 요청했어요.`
            : `${FOLDER_LABEL[observation.alias]} 폴더를 열었는지 확인하지 못했어요.`
        )
      if (observation.kind === 'audio') return describeAudio(report.tool, observation)
      const app = name(observation.appId)
      if (report.tool === 'apps.restore')
        return summary(
          outcomeOf(observation.status),
          observation.status === 'confirmed'
            ? `${app}(으)로 돌아갔어요.`
            : observation.status === 'dispatched'
              ? `${app}(으)로 돌아가도록 요청했어요.`
              : `${app}(으)로 돌아갔는지 확인하지 못했어요.`
        )
      const launching = report.tool === 'apps.launch'
      return summary(
        outcomeOf(observation.status),
        observation.status === 'confirmed'
          ? launching
            ? `${app}을(를) 열었어요.`
            : `${app}(으)로 전환했어요.`
          : observation.status === 'dispatched'
            ? launching
              ? `${app} 실행을 요청했어요.`
              : `${app} 전환을 요청했어요.`
            : launching
              ? `${app}을(를) 열었는지 확인하지 못했어요.`
              : `${app}(으)로 전환했는지 확인하지 못했어요.`
      )
    }
    case 'not_started':
      if (outcome.reason === 'cancelled')
        return summary('failure', `${TOOL_LABEL[report.tool]}을(를) 취소해서 실행하지 않았어요.`)
      if (outcome.reason === 'expired')
        return summary(
          'failure',
          `${TOOL_LABEL[report.tool]} 요청이 시간이 지나 실행하지 않았어요.`
        )
      return summary(
        'failure',
        `${TOOL_LABEL[report.tool]}을(를) 실행하지 않았어요. ${outcome.error?.message ?? ''}`.trim()
      )
    case 'failed':
      // A failure that may have acted is not a plain failure: whether it happened is not known.
      return outcome.effect === 'none'
        ? summary('failure', `${TOOL_LABEL[report.tool]}에 실패했어요. ${outcome.error.message}`)
        : summary(
            'unknown',
            `${TOOL_LABEL[report.tool]} 결과를 확인하지 못했어요. ${outcome.error.message}`
          )
    case 'unknown':
      return summary('unknown', `${TOOL_LABEL[report.tool]} 결과를 확인하지 못했어요.`)
  }
}

/** What the volume or mute change led to, using the state read back from the OS. */
function describeAudio(
  tool: ToolExecutionReport['tool'],
  observation: AudioObservation
): ReportSummary {
  const outcome = outcomeOf(observation.status)
  if (tool === 'system.mute') {
    if (observation.status === 'confirmed')
      return summary(outcome, observation.muted ? '음소거했어요.' : '음소거를 해제했어요.')
    return summary(
      outcome,
      observation.status === 'dispatched'
        ? '음소거 변경을 요청했어요.'
        : '음소거 상태를 확인하지 못했어요.'
    )
  }
  if (observation.status === 'confirmed')
    return summary(
      outcome,
      `볼륨을 ${observation.level}%로 맞췄어요.${observation.muted ? ' 지금은 음소거 상태예요.' : ''}`
    )
  return summary(
    outcome,
    observation.status === 'dispatched'
      ? '볼륨 변경을 요청했어요.'
      : `볼륨을 바꿨는지 확인하지 못했어요.${observation.level === null ? '' : ` 지금은 ${observation.level}%예요.`}`
  )
}
