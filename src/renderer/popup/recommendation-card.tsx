import { Sparkles } from 'lucide-react'
import type { RecommendationResponse } from '../../shared/contracts/recommendation'
import type { RecommendationView } from './view-model'

interface RecommendationCardProps {
  view: RecommendationView
  onRespond(response: RecommendationResponse): void
}

/**
 * A suggestion from the server. It is only an offer: choosing to run it asks the server, which
 * then sends the apps to open like any other request. Text from the server is shown as text only.
 */
export function RecommendationCard({ view, onRespond }: RecommendationCardProps) {
  return (
    <section className="recommendation" aria-label="추천">
      <div className="recommendation-head">
        <Sparkles aria-hidden="true" />
        <h2>이런 앱을 함께 열어 볼까요?</h2>
      </div>
      <p className="recommendation-reason">{view.reason}</p>
      <ul className="recommendation-apps" aria-label="추천하는 앱">
        {view.apps.map((name, index) => (
          <li key={`${index}-${name}`}>{name}</li>
        ))}
      </ul>
      <div className="recommendation-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={view.busy}
          onClick={() => onRespond('approved')}
        >
          {view.busy ? '보내는 중…' : '실행'}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={view.busy}
          onClick={() => onRespond('snoozed')}
        >
          나중에
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={view.busy}
          onClick={() => onRespond('rejected')}
        >
          거절
        </button>
        <button
          type="button"
          className="button button-ghost"
          disabled={view.busy}
          onClick={() => onRespond('dismissed')}
        >
          닫기
        </button>
      </div>
    </section>
  )
}
