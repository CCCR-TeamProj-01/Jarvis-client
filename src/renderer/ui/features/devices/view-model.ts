import type {
  AppItem,
  DeviceItem,
  DeviceManagementSnapshot,
  DeviceOutcome,
  DevicePlatform,
  OutcomeSubject
} from '../../../../shared/contracts/devices'
import { isValidDeviceName } from '../../../../shared/contracts/devices'
import { syncedLabel } from '../google/view-model'

const PLATFORM_LABEL: Record<DevicePlatform, string> = {
  windows: 'Windows',
  macos: 'macOS',
  other: '알 수 없는 운영체제'
}

export const platformLabel = (platform: DevicePlatform): string => PLATFORM_LABEL[platform]

/** Whether anything is being read or changed; the panels offer nothing else meanwhile. */
export function isWorking(snapshot: DeviceManagementSnapshot): boolean {
  return (
    snapshot.activity !== 'none' ||
    snapshot.devices.read === 'loading' ||
    snapshot.apps.read === 'loading'
  )
}

/** When a device was last seen, as a line under its name. */
export function lastSeenLabel(device: DeviceItem, timeZone: string | null): string {
  if (device.current) return '지금 사용 중'
  if (device.online) return '온라인'
  if (device.lastSeenAt === null) return '접속 기록 없음'
  return `마지막 접속 ${syncedLabel(device.lastSeenAt, timeZone)}`
}

/** `Windows · 0.1.0 · 마지막 접속 10월 22일 14:32`. */
export function deviceDetail(device: DeviceItem, timeZone: string | null): string {
  return [
    platformLabel(device.platform),
    device.clientVersion ? `v${device.clientVersion}` : null,
    lastSeenLabel(device, timeZone)
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

export type DeviceTone = 'ok' | 'idle' | 'warn' | 'error' | 'info'

export interface Notice {
  tone: 'info' | 'warn' | 'error'
  text: string
}

const OUTCOMES: Record<DeviceOutcome, { tone: Notice['tone']; text: string } | null> = {
  renamed: { tone: 'info', text: '기기 이름을 바꿨어요.' },
  device_signed_out: {
    tone: 'info',
    text: '그 기기의 로그인을 모두 끊었어요. 기기 등록은 남아 있어서 목록에는 계속 보여요.'
  },
  device_gone: { tone: 'warn', text: '이미 없는 기기예요. 목록을 새로 읽었어요.' },
  app_allowed: { tone: 'info', text: '이 앱을 허용했어요.' },
  app_blocked: {
    tone: 'info',
    text: '이 앱을 막았어요. 이제 자비스가 실행하거나 추천하지 않아요.'
  },
  app_gone: { tone: 'warn', text: '이미 없는 앱이에요. 목록을 새로 읽었어요.' },
  // Their wording is the error's own.
  unconfirmed: null,
  failed: null
}

/**
 * What the last change came to, for the panel it belongs to: the devices panel tells about devices
 * and the account, the apps panel about apps. A refused or failed change is told in its own words.
 */
function outcomeNotice(
  snapshot: DeviceManagementSnapshot,
  subjects: readonly OutcomeSubject[]
): Notice | null {
  const outcome = snapshot.outcome
  if (!outcome || !subjects.includes(outcome.subject)) return null
  if (outcome.kind === 'failed')
    return { tone: 'error', text: outcome.error?.message ?? '요청을 처리하지 못했어요.' }
  if (outcome.kind === 'unconfirmed')
    return { tone: 'warn', text: outcome.error?.message ?? '결과를 확인하지 못했어요.' }
  return OUTCOMES[outcome.kind]
}

export const deviceNotice = (snapshot: DeviceManagementSnapshot): Notice | null =>
  outcomeNotice(snapshot, ['device', 'account'])

export const appNotice = (snapshot: DeviceManagementSnapshot): Notice | null =>
  outcomeNotice(snapshot, ['app'])

/** The read of a list, in words, when it is not simply shown. */
export function readNotice(
  read: DeviceManagementSnapshot['devices']['read'],
  error: { message: string } | null,
  hasItems: boolean,
  what: string
): Notice | null {
  if (read === 'failed')
    return {
      tone: 'error',
      text: hasItems
        ? `${what}을(를) 새로 읽지 못했어요. 아래는 이전에 읽은 목록이라 최신이 아닐 수 있어요. ${error?.message ?? ''}`.trim()
        : (error?.message ?? `${what}을(를) 읽지 못했어요.`)
    }
  return null
}

export const appDetail = (app: AppItem): string =>
  app.allowed ? '자비스가 실행·전환·추천할 수 있어요' : '자비스가 실행·추천하지 않아요'

/** Whether the name in the rename form may be saved: it must fit the rule and differ from the current one. */
export function renameCheck(
  input: string,
  currentName: string
): { valid: boolean; canSave: boolean } {
  const valid = isValidDeviceName(input)
  return { valid, canSave: valid && input.trim() !== currentName }
}
