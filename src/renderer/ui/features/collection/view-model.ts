import { collectionIsOn } from '../../../../shared/contracts/collection'
import type { CollectionFlag, CollectionSnapshot } from '../../../../shared/contracts/collection'
import type { Notice } from '../devices/view-model'

export const FLAG_LABEL: Record<CollectionFlag, string> = {
  activity: '자비스 활동 수집',
  external: '외부 앱 활동 수집'
}

export const FLAG_DETAIL: Record<CollectionFlag, string> = {
  activity: '자비스로 열거나 전환한 앱을 기록해 추천에 써요',
  external: '자비스로 앱을 열 때 그때 실행 중이던 다른 앱의 이름도 함께 보내요'
}

export interface CollectionRow {
  flag: CollectionFlag
  /** Not known until the settings were read. */
  state: 'on' | 'off' | 'unknown'
  /** The server still holds it on, though it is no longer collected here. */
  notApplied: boolean
  /** The switch may be used: the settings are known, and external needs activity. */
  enabled: boolean
  /** Why it may not be used, when that is worth saying. */
  blockedReason: string | null
}

/** Whether anything is being read or saved; nothing else is offered meanwhile. */
export const isWorking = (snapshot: CollectionSnapshot): boolean =>
  snapshot.saving || snapshot.read === 'loading'

export function collectionRows(snapshot: CollectionSnapshot): CollectionRow[] {
  const known = snapshot.settings !== null
  const activityOn = collectionIsOn('activity', snapshot.settings, snapshot.stopped)
  return (['activity', 'external'] as const).map((flag) => {
    const on = collectionIsOn(flag, snapshot.settings, snapshot.stopped)
    // Held back here, but the server's value is still on: the withdrawal has not reached it.
    const notApplied =
      known &&
      snapshot.stopped[flag] &&
      (flag === 'activity' ? snapshot.settings!.activity : snapshot.settings!.external)
    const blocked = flag === 'external' && !activityOn
    return {
      flag,
      state: !known ? 'unknown' : on ? 'on' : 'off',
      notApplied,
      enabled: known && !blocked,
      blockedReason: known && blocked && !on ? '자비스 활동 수집을 먼저 켜야 해요' : null
    }
  })
}

/** What the last change came to, in words. */
export function collectionNotice(snapshot: CollectionSnapshot): Notice | null {
  const outcome = snapshot.outcome
  if (!outcome) return null
  const what = FLAG_LABEL[outcome.flag]
  if (outcome.kind === 'saved')
    return outcome.on
      ? { tone: 'info', text: `${what}을 켰어요.` }
      : {
          tone: 'info',
          text:
            outcome.flag === 'activity'
              ? `${what}을 껐어요. 서버에도 반영했고 외부 앱 활동 수집도 함께 꺼졌어요.`
              : `${what}을 껐어요. 서버에도 반영했어요.`
        }
  if (!outcome.on)
    // A withdrawal holds on this computer whatever the server said.
    return {
      tone: 'warn',
      text: `${what}은 이 기기에서 멈췄지만 서버에는 반영하지 못했어요. 다시 반영해 주세요.`
    }
  if (outcome.kind === 'unconfirmed')
    return {
      tone: 'warn',
      text: '서버의 응답을 받지 못해 결과를 확인하지 못했어요. 설정을 다시 읽었어요.'
    }
  return { tone: 'error', text: outcome.error?.message ?? '설정을 바꾸지 못했어요.' }
}

/** The settings could not be read: said in place of a value, never as "off". */
export function readProblem(snapshot: CollectionSnapshot): Notice | null {
  if (snapshot.read !== 'failed') return null
  return {
    tone: 'error',
    text:
      snapshot.settings !== null
        ? `설정을 새로 읽지 못했어요. 아래 값은 이전에 읽은 것이라 최신이 아닐 수 있어요. ${snapshot.error?.message ?? ''}`.trim()
        : (snapshot.error?.message ?? '설정을 읽지 못했어요.')
  }
}
