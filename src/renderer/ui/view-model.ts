import type { ClientSnapshot, Tab, UiEvent } from '../../shared/contracts/interaction'
import type { PermissionState, SensorKind } from '../../shared/contracts/sensors'

export type Tone = 'ok' | 'idle' | 'info' | 'ai' | 'warn' | 'error'

/** A line in the conversation log, from the user, the assistant or a tool. */
export interface Message {
  id: number
  requestId: string
  role: 'user' | 'assistant' | 'tool'
  text: string
}

const MAX_MESSAGES = 60

/** The log with a new line added; only the most recent lines are kept. */
export function appendMessage(
  messages: readonly Message[],
  event: Extract<UiEvent, { type: 'result.available' }>,
  id: number
): Message[] {
  return [
    ...messages,
    { id, requestId: event.requestId, role: event.role, text: event.text }
  ].slice(-MAX_MESSAGES)
}

/** The tab the signed-in window shows; anything that is not one of the tabs means the conversation. */
export function activeTab(snapshot: Pick<ClientSnapshot, 'screen'>): Tab {
  return snapshot.screen === 'calendar' ||
    snapshot.screen === 'gesture' ||
    snapshot.screen === 'settings'
    ? snapshot.screen
    : 'conversation'
}

export interface StatusLine {
  id: 'microphone' | 'gesture' | 'server'
  label: string
  value: string
  tone: Tone
}

const sensor = (snapshot: ClientSnapshot, kind: SensorKind) =>
  snapshot.sensors.find((entry) => entry.kind === kind)

/** What the conversation tab's side panel says about the parts that are running. */
export function statusLines(snapshot: ClientSnapshot): StatusLine[] {
  const microphone = sensor(snapshot, 'microphone')
  const mic: StatusLine = snapshot.recognitionPaused
    ? { id: 'microphone', label: '마이크', value: '일시 중지', tone: 'idle' }
    : microphone?.permission === 'denied' || microphone?.permission === 'restricted'
      ? { id: 'microphone', label: '마이크', value: '권한이 필요해요', tone: 'warn' }
      : microphone?.state === 'active'
        ? { id: 'microphone', label: '마이크', value: '사용 중', tone: 'ok' }
        : { id: 'microphone', label: '마이크', value: '대기 중', tone: 'idle' }
  const gesture: StatusLine = snapshot.recognitionPaused
    ? { id: 'gesture', label: '제스처', value: '일시 중지', tone: 'idle' }
    : snapshot.gesture.phase === 'off'
      ? { id: 'gesture', label: '제스처', value: '꺼짐', tone: 'idle' }
      : snapshot.gesture.phase === 'lost'
        ? { id: 'gesture', label: '제스처', value: '손을 찾는 중', tone: 'info' }
        : snapshot.gesture.phase === 'suspended'
          ? { id: 'gesture', label: '제스처', value: '잠시 멈춤', tone: 'idle' }
          : {
              id: 'gesture',
              label: '제스처',
              value: snapshot.gesture.pointing ? '켜짐 · 포인팅' : '켜짐 · 커서 멈춤',
              tone: 'ok'
            }
  const server: StatusLine =
    snapshot.connection === 'online'
      ? { id: 'server', label: '서버', value: '연결됨', tone: 'ok' }
      : snapshot.connection === 'connecting'
        ? { id: 'server', label: '서버', value: '연결 중', tone: 'info' }
        : { id: 'server', label: '서버', value: '연결 안 됨', tone: 'idle' }
  return [mic, gesture, server]
}

/** The chip beside the conversation title: what the voice side and the current request are doing. */
export function conversationStatus(snapshot: ClientSnapshot): { text: string; tone: Tone } {
  if (snapshot.recognitionPaused) return { text: '인식 일시 중지', tone: 'idle' }
  switch (snapshot.speech.phase) {
    case 'wake_detected':
    case 'awaiting_speech':
    case 'listening':
    case 'awaiting_followup':
      return { text: '듣는 중', tone: 'ok' }
    case 'transcribing':
    case 'processing':
      return { text: '처리 중', tone: 'ai' }
    case 'speaking':
      return { text: '응답 중', tone: 'info' }
    case 'idle':
      break
  }
  if (snapshot.request.phase === 'processing') return { text: '처리 중', tone: 'ai' }
  return snapshot.conversation.phase === 'active'
    ? { text: '대화 중', tone: 'info' }
    : { text: '대기 중', tone: 'idle' }
}

/** Voice is in use: listening, thinking or speaking. */
export const voiceActive = (snapshot: ClientSnapshot): boolean => snapshot.speech.phase !== 'idle'

export interface PermissionLine {
  kind: SensorKind
  label: string
  value: string
  tone: Tone
  hint: string | null
}

const PERMISSION: Record<PermissionState, { value: string; tone: Tone; hint: string | null }> = {
  granted: { value: '허용됨', tone: 'ok', hint: null },
  not_determined: {
    value: '아직 요청 전',
    tone: 'idle',
    hint: '처음 사용할 때 허용 여부를 물어봐요.'
  },
  denied: {
    value: '거부됨',
    tone: 'warn',
    hint: '시스템 설정의 개인정보 보호에서 자비스를 허용해 주세요.'
  },
  restricted: {
    value: '제한됨',
    tone: 'warn',
    hint: '이 기기의 설정이나 관리자 정책이 사용을 막고 있어요.'
  },
  unsupported: { value: '지원하지 않음', tone: 'idle', hint: null }
}

const LABEL: Record<SensorKind, string> = { microphone: '마이크', camera: '카메라' }

/** Microphone and camera permission as the settings tab lists it, with what to do when it is not granted. */
export function permissionLines(snapshot: ClientSnapshot): PermissionLine[] {
  return (['microphone', 'camera'] as const).map((kind) => {
    const permission = sensor(snapshot, kind)?.permission ?? 'not_determined'
    return { kind, label: LABEL[kind], ...PERMISSION[permission] }
  })
}

/** "CommandOrControl+Shift+Space" as the keys to show on this platform. */
export function acceleratorKeys(accelerator: string, platform: string): string[] {
  const mac = platform === 'darwin'
  return accelerator.split('+').map((key) => {
    switch (key) {
      case 'CommandOrControl':
        return mac ? '⌘' : 'Ctrl'
      case 'Command':
        return '⌘'
      case 'Control':
        return 'Ctrl'
      case 'Alt':
      case 'Option':
        return mac ? '⌥' : 'Alt'
      case 'Shift':
        return mac ? '⇧' : 'Shift'
      default:
        return key
    }
  })
}
