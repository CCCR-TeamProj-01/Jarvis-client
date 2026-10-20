import { Hand, Square } from 'lucide-react'
import type { GestureSnapshot } from '../../../../shared/contracts/gesture'

const PHASE_LABEL: Record<GestureSnapshot['phase'], string> = {
  off: '손으로 커서를 움직이고 엄지와 검지를 모으면 클릭해요. 영상은 이 기기에서만 처리돼요.',
  lost: '손을 찾고 있어요. 카메라에 손을 보여 주세요.',
  tracking: '손으로 제어하고 있어요.',
  suspended: '제스처 제어가 잠시 멈춰 있어요.'
}

export function gestureLabel(phase: GestureSnapshot['phase']): string {
  return PHASE_LABEL[phase]
}

interface GesturePanelProps {
  phase: GestureSnapshot['phase']
  paused: boolean
  /** The shortcut that turns gesture control on and off, already formatted for display. */
  shortcut: string
  onStart(): void
  onStop(): void
}

/** Gesture control as the user sees it: what it is doing, and a way to start and stop it. */
export function GesturePanel({ phase, paused, shortcut, onStart, onStop }: GesturePanelProps) {
  const running = phase !== 'off'
  return (
    <section className="gesture" aria-label="제스처 제어">
      <p className="conversation-status" role="status" aria-live="polite">
        {paused && !running ? '인식이 일시 중지되어 있어요.' : gestureLabel(phase)}
      </p>
      {running ? (
        <button className="button button-secondary" type="button" onClick={onStop}>
          <Square aria-hidden="true" />
          제스처 중지 <kbd>{shortcut}</kbd>
        </button>
      ) : (
        <button
          className="button button-secondary"
          type="button"
          disabled={paused}
          onClick={onStart}
        >
          <Hand aria-hidden="true" />
          제스처 시작 <kbd>{shortcut}</kbd>
        </button>
      )}
    </section>
  )
}
