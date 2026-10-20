import { Mic, Square } from 'lucide-react'
import type { SpeechSnapshot } from '../../../../shared/contracts/speech'

export interface ConversationMessage {
  id: number
  text: string
}

const PHASE_LABEL: Record<SpeechSnapshot['phase'], string> = {
  idle: '대화를 시작하려면 버튼을 누르거나 호출 단축키를 사용하세요.',
  wake_detected: '호출을 확인했어요.',
  awaiting_speech: '말씀하세요…',
  listening: '듣고 있어요…',
  transcribing: '인식하고 있어요…',
  processing: '답을 만들고 있어요…',
  speaking: '답하고 있어요…',
  awaiting_followup: '이어서 말씀하세요…'
}

export function phaseLabel(phase: SpeechSnapshot['phase']): string {
  return PHASE_LABEL[phase]
}

interface ConversationPanelProps {
  phase: SpeechSnapshot['phase']
  paused: boolean
  messages: ConversationMessage[]
  onStart(): void
  onStop(): void
}

/** A minimal view of the voice conversation: where it is, what was said, and start/stop. */
export function ConversationPanel({
  phase,
  paused,
  messages,
  onStart,
  onStop
}: ConversationPanelProps) {
  const active = phase !== 'idle'
  return (
    <section className="conversation" aria-label="음성 대화">
      <p className="conversation-status" role="status" aria-live="polite">
        {paused && !active ? '인식이 일시 중지되어 있어요.' : phaseLabel(phase)}
      </p>
      {messages.length > 0 && (
        <ul className="conversation-log">
          {messages.map((message) => (
            <li key={message.id}>{message.text}</li>
          ))}
        </ul>
      )}
      {active ? (
        <button className="button button-secondary" type="button" onClick={onStop}>
          <Square aria-hidden="true" />
          대화 중지
        </button>
      ) : (
        <button
          className="button button-secondary"
          type="button"
          disabled={paused}
          onClick={onStart}
        >
          <Mic aria-hidden="true" />
          대화 시작
        </button>
      )}
    </section>
  )
}
