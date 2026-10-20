import type { GestureSnapshot } from '../../shared/contracts/gesture'
import type { OverlayKind } from '../../shared/contracts/overlay'
import type { SpeechSnapshot } from '../../shared/contracts/speech'

/** A pill before it is given an ID. */
export interface PillContent {
  kind: OverlayKind
  text: string
  stoppable: boolean
}

export interface OverlayInputs {
  speechPhase: SpeechSnapshot['phase']
  /** A request is being answered, however it was entered. */
  requestProcessing: boolean
  gesture: Pick<GestureSnapshot, 'phase' | 'pointing'>
}

const VOICE: Partial<Record<SpeechSnapshot['phase'], PillContent>> = {
  wake_detected: { kind: 'listening', text: '부르셨어요', stoppable: false },
  awaiting_speech: { kind: 'listening', text: '말씀하세요…', stoppable: false },
  listening: { kind: 'listening', text: '듣고 있어요…', stoppable: false },
  transcribing: { kind: 'thinking', text: '인식하고 있어요…', stoppable: false },
  processing: { kind: 'thinking', text: '처리하고 있어요…', stoppable: false },
  speaking: { kind: 'speaking', text: '답하고 있어요', stoppable: true },
  awaiting_followup: { kind: 'listening', text: '이어서 말씀하세요…', stoppable: false }
}

/**
 * What stays on screen for as long as it is true: the voice pill follows the speech session (or a
 * typed request being worked on) and the gesture pill follows the gesture mode. Idle shows nothing.
 */
export function derivePersistent(inputs: OverlayInputs): {
  voice: PillContent | null
  gesture: PillContent | null
} {
  const voice =
    VOICE[inputs.speechPhase] ??
    (inputs.requestProcessing
      ? { kind: 'thinking' as const, text: '처리하고 있어요…', stoppable: false }
      : null)
  return { voice, gesture: gesturePill(inputs.gesture) }
}

function gesturePill(gesture: OverlayInputs['gesture']): PillContent | null {
  switch (gesture.phase) {
    case 'off':
      return null
    case 'lost':
      return { kind: 'searching', text: '손을 찾는 중', stoppable: false }
    case 'suspended':
      return { kind: 'paused', text: '제스처 일시 정지', stoppable: false }
    case 'tracking':
      return gesture.pointing
        ? { kind: 'pointing', text: '포인팅', stoppable: false }
        : { kind: 'holding', text: '커서 멈춤', stoppable: false }
  }
}
