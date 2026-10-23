import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CircleAlert } from 'lucide-react'
import type {
  RecommendationAnswer,
  RecommendationCard as Card
} from '../../shared/contracts/recommendation'
import { RecommendationCard } from './recommendation-card'
import { recommendationView } from './view-model'
import './popup.css'

/** The recommendation popup: draws the card Main gives it and sends the answer back. */
function Popup(): React.JSX.Element | null {
  const api = window.jarvisPopup
  const [card, setCard] = useState<Card | null>(null)
  const [error, setError] = useState<string | null>(null)
  const frame = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!api) return
    let active = true
    const unsubscribe = api.subscribe((next) => {
      if (!active) return
      setCard(next)
      // A message about an earlier card does not belong to the next one.
      setError(null)
    })
    void api.getState().then((first) => {
      if (active) setCard((current) => current ?? first)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [api])

  // Tell Main how tall the content is, so the window is as tall as the card and no taller. The
  // observer follows the content as it grows (an error message) or shrinks.
  const hasCard = card !== null
  useLayoutEffect(() => {
    const element = frame.current
    if (!api || !hasCard || !element) return
    const report = () => api.resize(element.getBoundingClientRect().height)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  }, [api, hasCard])

  const view = recommendationView(card)
  if (!view) return null

  async function respond(answer: RecommendationAnswer) {
    if (!api || !view) return
    setError(null)
    const answered = await api.respond(view.recommendationId, answer)
    if (!answered.ok) setError(answered.error.message)
  }

  return (
    <div className="popup" ref={frame}>
      <RecommendationCard
        key={view.recommendationId}
        view={view}
        onRespond={(answer) => void respond(answer)}
      />
      {error && (
        <p className="popup-error" role="alert">
          <CircleAlert aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>
)
