import { useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import type { RecommendationAnswer } from '../../shared/contracts/recommendation'
import type { RecommendationView } from './view-model'

interface RecommendationCardProps {
  view: RecommendationView
  onRespond(answer: RecommendationAnswer): void
}

/**
 * A suggestion from the server. It is only an offer: choosing to run it asks the server, which
 * then sends the apps to open like any other request. Text from the server is shown as text only.
 *
 * Rejecting takes a second step on the same card (for 7 days, or just this once); nothing is sent
 * until the user picks one. "Not today" rides along with whichever answer is sent. How long any
 * of this holds back a suggestion is the server's rule, so nothing is counted here.
 */
export function RecommendationCard({ view, onRespond }: RecommendationCardProps) {
  const [rejecting, setRejecting] = useState(false)
  const [pauseToday, setPauseToday] = useState(false)
  return (
    <RecommendationCardBody
      view={view}
      rejecting={rejecting}
      pauseToday={pauseToday}
      onReject={() => setRejecting(true)}
      onBack={() => setRejecting(false)}
      onPauseToday={setPauseToday}
      onRespond={(response) => onRespond({ response, pauseToday })}
    />
  )
}

interface RecommendationCardBodyProps {
  view: RecommendationView
  /** On the second step of rejecting: for 7 days, or just this once. */
  rejecting: boolean
  pauseToday: boolean
  onReject(): void
  onBack(): void
  onPauseToday(checked: boolean): void
  onRespond(response: RecommendationAnswer['response']): void
}

/** What the card shows for a given step; it keeps no state of its own. */
export function RecommendationCardBody({
  view,
  rejecting,
  pauseToday,
  onReject,
  onBack,
  onPauseToday,
  onRespond: send
}: RecommendationCardBodyProps) {
  return (
    <section className="recommendation" aria-label="추천">
      <div className="recommendation-head">
        <Sparkles aria-hidden="true" />
        <h2>이런 앱을 함께 열어 볼까요?</h2>
        <button
          type="button"
          className="recommendation-close"
          aria-label="닫기"
          disabled={view.busy}
          onClick={() => send('dismiss')}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <p className="recommendation-reason">{view.reason}</p>
      <ul className="recommendation-apps" aria-label="추천하는 앱">
        {view.apps.map((name, index) => (
          <li key={`${index}-${name}`}>{name}</li>
        ))}
      </ul>
      {rejecting ? (
        <>
          <p className="recommendation-question">이 앱 조합을 7일 동안 추천받지 않을까요?</p>
          <div className="recommendation-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={view.busy}
              onClick={() => send('reject_for_7_days')}
            >
              {view.busy ? '보내는 중…' : '7일간 받지 않기'}
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={view.busy}
              onClick={() => send('reject_once')}
            >
              이번만 거절
            </button>
            <button
              type="button"
              className="button button-ghost"
              disabled={view.busy}
              onClick={onBack}
            >
              뒤로
            </button>
          </div>
        </>
      ) : (
        <div className="recommendation-actions">
          <button
            type="button"
            className="button button-primary"
            disabled={view.busy}
            onClick={() => send('execute')}
          >
            {view.busy ? '보내는 중…' : '실행'}
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={view.busy}
            onClick={() => send('snoozed')}
          >
            나중에
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={view.busy}
            onClick={onReject}
          >
            거절
          </button>
        </div>
      )}
      <label className="recommendation-pause">
        <input
          type="checkbox"
          checked={pauseToday}
          disabled={view.busy}
          onChange={(event) => onPauseToday(event.target.checked)}
        />
        오늘 추천받지 않기
      </label>
    </section>
  )
}
