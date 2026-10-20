import { useState } from 'react'
import type { FormEvent } from 'react'
import { Mic, SendHorizontal, Square } from 'lucide-react'
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
  /** A conversation exists, whether or not the voice side is listening. */
  conversationActive: boolean
  /** A request is being answered right now. */
  working: boolean
  paused: boolean
  messages: ConversationMessage[]
  onStart(): void
  onStop(): void
  onSubmitText(text: string): void
}

/** The conversation as the user sees it: status, what was said, voice start/stop and a text box. */
export function ConversationPanel({
  phase,
  conversationActive,
  working,
  paused,
  messages,
  onStart,
  onStop,
  onSubmitText
}: ConversationPanelProps) {
  const [draft, setDraft] = useState('')
  const voiceActive = phase !== 'idle'
  const status =
    paused && !conversationActive
      ? '인식이 일시 중지되어 있어요.'
      : voiceActive
        ? phaseLabel(phase)
        : conversationActive
          ? working
            ? '답을 만들고 있어요…'
            : '대화 중이에요. 글로 입력하거나 음성으로 이어갈 수 있어요.'
          : phaseLabel('idle')

  function submit(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (text.length === 0 || paused) return
    setDraft('')
    onSubmitText(text)
  }

  return (
    <section className="conversation" aria-label="대화">
      <p className="conversation-status" role="status" aria-live="polite">
        {status}
      </p>
      {messages.length > 0 && (
        <ul className="conversation-log">
          {messages.map((message) => (
            <li key={message.id}>{message.text}</li>
          ))}
        </ul>
      )}
      <form className="conversation-input" onSubmit={submit}>
        <input
          aria-label="메시지 입력"
          placeholder="글로 입력하세요"
          value={draft}
          disabled={paused}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          className="button button-secondary"
          type="submit"
          aria-label="보내기"
          disabled={paused || draft.trim().length === 0}
        >
          <SendHorizontal aria-hidden="true" />
        </button>
      </form>
      {voiceActive || conversationActive ? (
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
      {conversationActive && !voiceActive && !paused && (
        <button className="button button-ghost" type="button" onClick={onStart}>
          <Mic aria-hidden="true" />
          음성으로 이어가기
        </button>
      )}
    </section>
  )
}
