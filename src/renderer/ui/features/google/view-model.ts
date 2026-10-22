import type {
  GoogleAction,
  GoogleConnectionSnapshot,
  GoogleOutcome
} from '../../../../shared/contracts/google-connection'
import { clockTime } from '../calendar/view-model'

/** `10월 22일 14:32`, in the user's time zone when it is known. */
export function syncedLabel(ms: number, timeZone: string | null): string {
  const options: Intl.DateTimeFormatOptions = {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('ko-KR', {
      ...options,
      ...(timeZone ? { timeZone } : {})
    }).formatToParts(new Date(ms))
  } catch {
    parts = new Intl.DateTimeFormat('ko-KR', options).formatToParts(new Date(ms))
  }
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? ''
  return `${part('month')}월 ${part('day')}일 ${part('hour')}:${part('minute')}`
}

export type GoogleTone = 'ok' | 'idle' | 'warn' | 'error' | 'info'

export interface GoogleButton {
  action: GoogleAction
  label: string
  /** The one that goes with the state; the others are secondary. */
  primary?: boolean
}

export interface GoogleView {
  tone: GoogleTone
  /** A word or two for the state. */
  chip: string
  detail: string
  buttons: GoogleButton[]
  /** What just happened, when there is something to say about it. */
  notice: { tone: 'info' | 'warn' | 'error'; text: string } | null
}

const OUTCOMES: Record<GoogleOutcome, { tone: 'info' | 'warn'; text: string } | null> = {
  connected: null,
  synced: { tone: 'info', text: '동기화를 마쳤어요. 일정을 새로 불러왔어요.' },
  sync_unconfirmed: {
    tone: 'warn',
    text: '동기화가 끝났는지 확인하지 못했어요. Google 일정이 최신이 아닐 수 있어요.'
  },
  disconnected: {
    tone: 'info',
    text: '연결을 해제했어요. 가져온 Google 일정은 지웠어요.'
  },
  connect_expired: {
    tone: 'warn',
    text: '시간이 지나 연결을 마치지 못했어요. 다시 시도해 주세요.'
  },
  connect_cancelled: {
    tone: 'info',
    text: '연결을 취소했어요. 브라우저에서 이미 동의했다면 잠시 뒤 연결 상태가 나타날 수 있어요.'
  }
}

/** The connection as the settings panel draws it: a state, what to do about it, and what just happened. */
export function googleView(
  snapshot: GoogleConnectionSnapshot,
  timeZone: string | null
): GoogleView {
  const outcome = snapshot.outcome ? OUTCOMES[snapshot.outcome.kind] : null
  const notice = snapshot.error ? { tone: 'error' as const, text: snapshot.error.message } : outcome
  const base = { notice }
  const { connection } = snapshot

  if (snapshot.availability === 'unavailable')
    return {
      ...base,
      tone: 'idle',
      chip: '사용할 수 없음',
      detail: '서버에 연결되지 않은 상태라 Google 캘린더를 연결할 수 없어요.',
      buttons: []
    }
  if (snapshot.activity === 'authorizing')
    return {
      ...base,
      tone: 'info',
      chip: '연결 중',
      detail: `브라우저에서 Google 동의를 마쳐 주세요.${
        snapshot.authorizeUntil !== null
          ? ` ${clockTime(snapshot.authorizeUntil, timeZone)}까지 기다려요.`
          : ''
      }`,
      buttons: [{ action: 'cancel_connect', label: '취소' }]
    }
  if (snapshot.activity === 'syncing')
    return {
      ...base,
      tone: 'info',
      chip: '동기화 중',
      detail: 'Google 일정을 가져오고 있어요. 끝나면 일정이 새로 고쳐져요.',
      buttons: []
    }
  if (snapshot.activity === 'disconnecting')
    return {
      ...base,
      tone: 'info',
      chip: '해제 중',
      detail: '연결을 해제하고 있어요.',
      buttons: []
    }
  if (connection === null) {
    if (snapshot.read === 'failed')
      return {
        ...base,
        tone: 'error',
        chip: '확인하지 못함',
        detail: '연결 상태를 확인하지 못했어요.',
        buttons: [{ action: 'refresh', label: '다시 시도' }]
      }
    if (snapshot.read !== 'ready')
      return {
        ...base,
        tone: 'idle',
        chip: '확인 중',
        detail: '연결 상태를 확인하고 있어요.',
        buttons: []
      }
    return {
      ...base,
      tone: 'idle',
      chip: '연결 안 됨',
      detail: '연결하면 Google 일정을 이 앱에서 읽기 전용으로 볼 수 있어요.',
      buttons: [{ action: 'connect', label: '연결', primary: true }]
    }
  }
  if (connection.status === 'reconnect_required')
    return {
      ...base,
      tone: 'warn',
      chip: '다시 연결 필요',
      detail: 'Google 연결이 만료되어 일정을 가져올 수 없어요. 다시 연결해 주세요.',
      buttons: [
        { action: 'connect', label: '다시 연결', primary: true },
        { action: 'disconnect', label: '연결 해제' }
      ]
    }
  return {
    ...base,
    tone: 'ok',
    chip: '연결됨',
    detail:
      connection.lastSyncedAt === null
        ? '아직 Google 일정을 가져온 적이 없어요.'
        : `마지막 동기화 ${syncedLabel(connection.lastSyncedAt, timeZone)}`,
    buttons: [
      { action: 'sync', label: '지금 동기화', primary: true },
      { action: 'disconnect', label: '연결 해제' }
    ]
  }
}

/** The one line the calendar tab keeps about Google, for how current its Google events are. */
export interface GoogleLine {
  tone: 'info' | 'warn'
  text: string
  /** There is something to do in the settings. */
  openSettings: boolean
}

export function googleLine(
  snapshot: GoogleConnectionSnapshot | null,
  timeZone: string | null
): GoogleLine | null {
  if (!snapshot || snapshot.availability === 'unavailable') return null
  const { connection } = snapshot
  if (snapshot.activity === 'syncing')
    return { tone: 'info', text: 'Google 일정을 동기화하고 있어요.', openSettings: false }
  if (snapshot.activity === 'authorizing')
    return { tone: 'info', text: 'Google 연결을 기다리고 있어요.', openSettings: true }
  if (connection === null) {
    if (snapshot.read === 'failed')
      return {
        tone: 'warn',
        text: 'Google 캘린더 연결 상태를 확인하지 못했어요.',
        openSettings: true
      }
    return snapshot.read === 'ready'
      ? { tone: 'info', text: 'Google 캘린더가 연결되지 않았어요.', openSettings: true }
      : null
  }
  if (connection.status === 'reconnect_required')
    return {
      tone: 'warn',
      text: 'Google 연결이 만료됐어요. 다시 연결해 주세요.',
      openSettings: true
    }
  const unsure = snapshot.outcome?.kind === 'sync_unconfirmed'
  const synced =
    connection.lastSyncedAt === null
      ? 'Google 일정을 아직 가져오지 않았어요.'
      : `Google 일정은 ${syncedLabel(connection.lastSyncedAt, timeZone)}에 동기화했어요.`
  return unsure
    ? {
        tone: 'warn',
        text: `${synced} 최근 동기화가 끝났는지 확인하지 못했어요.`,
        openSettings: true
      }
    : { tone: 'info', text: synced, openSettings: false }
}
