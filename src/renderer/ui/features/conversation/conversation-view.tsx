import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { CircleCheck, CircleHelp, CircleX, Mic, Send, SendHorizontal, Square } from 'lucide-react'
import type { Message, Tone } from '../../view-model'
import { OUTCOME_VIEW } from '../../view-model'
import { Keys, StatusChip } from '../shell/status-chip'

interface ConversationViewProps {
  status: { text: string; tone: Tone }
  messages: readonly Message[]
  paused: boolean
  /** A conversation exists or the voice side is running, so there is something to stop. */
  stoppable: boolean
  callKeys: string[]
  onSubmitText(text: string): void
  onStartVoice(): void
  onStop(): void
}

/** The conversation as the user sees it: what was said and done, a text box and the voice button. */
export function ConversationView({
  status,
  messages,
  paused,
  stoppable,
  callKeys,
  onSubmitText,
  onStartVoice,
  onStop
}: ConversationViewProps) {
  const [draft, setDraft] = useState('')
  const end = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [messages.length])

  function submit(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (text.length === 0 || paused) return
    setDraft('')
    onSubmitText(text)
  }

  return (
    <section className="view" aria-labelledby="conversation-title">
      <header className="view-head">
        <h1 id="conversation-title">대화</h1>
        <div className="view-head-end">
          <StatusChip tone={status.tone}>{status.text}</StatusChip>
          <span className="hint">
            호출 <Keys keys={callKeys} label="호출 단축키" />
          </span>
        </div>
      </header>

      <div className="log" role="log" aria-live="polite" aria-label="대화 내용">
        {messages.length === 0 && (
          <p className="log-empty">
            글로 입력하거나 음성 대화를 시작해 보세요. “앱 목록 알려줘”처럼 요청할 수 있어요.
          </p>
        )}
        {messages.map((message) =>
          message.role === 'user' ? (
            <p className="msg msg-user" key={message.id}>
              {message.text}
            </p>
          ) : message.role === 'tool' ? (
            <p
              className={`msg msg-tool msg-tool-${OUTCOME_VIEW[message.outcome ?? 'unknown'].tone}`}
              key={message.id}
            >
              <span className="msg-tool-icon" aria-hidden="true">
                {message.outcome === 'success' ? (
                  <CircleCheck />
                ) : message.outcome === 'failure' ? (
                  <CircleX />
                ) : message.outcome === 'requested' ? (
                  <Send />
                ) : (
                  <CircleHelp />
                )}
              </span>
              <small>{OUTCOME_VIEW[message.outcome ?? 'unknown'].label}</small>
              <span className="msg-tool-text">{message.text}</span>
            </p>
          ) : (
            <div className="msg msg-assistant" key={message.id}>
              <span className="orb" aria-hidden="true" />
              <p className="bubble">{message.text}</p>
            </div>
          )
        )}
        <div ref={end} />
      </div>

      <form className="composer" onSubmit={submit} aria-label="메시지 보내기">
        <input
          className="composer-input"
          aria-label="메시지 입력"
          placeholder="글로 입력하세요"
          value={draft}
          disabled={paused}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          className="button button-send"
          type="submit"
          aria-label="보내기"
          disabled={paused || draft.trim().length === 0}
        >
          <SendHorizontal aria-hidden="true" />
        </button>
        {stoppable ? (
          <button className="button button-voice-stop" type="button" onClick={onStop}>
            <Square aria-hidden="true" />
            대화 중지
          </button>
        ) : (
          <button
            className="button button-voice"
            type="button"
            disabled={paused}
            onClick={onStartVoice}
          >
            <Mic aria-hidden="true" />
            음성 대화
          </button>
        )}
      </form>
    </section>
  )
}
