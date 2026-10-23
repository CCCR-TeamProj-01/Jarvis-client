import type { ReportSummary } from '../tools/describe-report'
import type { CommandResult } from './command-result'

/** What a server command type is called to the user. A type this client does not know is just a command. */
const COMMAND_LABEL: ReadonlyMap<string, string> = new Map([
  ['apps.launch', '앱 실행'],
  ['apps.activate', '앱 전환'],
  ['apps.close', '앱 종료'],
  ['apps.restore', '이전 작업으로 돌아가기'],
  ['apps.list', '앱 목록 확인'],
  ['browser.open', '주소 열기'],
  ['browser.search', '검색 열기'],
  ['folder.open', '폴더 열기'],
  ['system.volume', '볼륨 조절'],
  ['system.mute', '음소거'],
  ['system.status', '시스템 상태 확인']
])

/** The name of a command for the user; the type itself (which the server chose) is never shown. */
export const commandLabel = (commandType: string | null): string =>
  (commandType !== null ? COMMAND_LABEL.get(commandType) : undefined) ?? '명령'

/**
 * The words for a command that was not run, or whose outcome is not known: it was refused, it came
 * too late, or the run was cut short. Only the fixed sentence the result already carries is used,
 * with the name of the command in front so it is clear which one it was.
 */
export function summarizeUnrun(commandType: string | null, result: CommandResult): ReportSummary {
  const outcome = result.status === 'unknown' ? 'unknown' : 'failure'
  return {
    outcome,
    ok: false,
    text: `${commandLabel(commandType)}: ${result.result_message ?? '실행하지 않았어요.'}`
  }
}
