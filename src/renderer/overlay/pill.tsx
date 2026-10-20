import { Check, CircleAlert, MousePointer2, Pause, Search, Square, Volume2, X } from 'lucide-react'
import type { OverlayKind, OverlayPill } from '../../shared/contracts/overlay'

/** The mark in the round badge. Listening and clicking are drawn rather than iconised. */
function Badge({ kind }: { kind: OverlayKind }) {
  switch (kind) {
    case 'listening':
      return (
        <span className="wave" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      )
    case 'thinking':
      return null
    case 'speaking':
      return <Volume2 aria-hidden="true" />
    case 'done':
      return <Check aria-hidden="true" strokeWidth={2.6} />
    case 'error':
      return <CircleAlert aria-hidden="true" />
    case 'pointing':
      return <MousePointer2 aria-hidden="true" />
    case 'holding':
      return <Square aria-hidden="true" />
    case 'searching':
      return <Search aria-hidden="true" />
    case 'clicking':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          aria-hidden="true"
        >
          <circle cx="9" cy="12" r="5" />
          <circle cx="15" cy="12" r="5" />
        </svg>
      )
    case 'paused':
      return <Pause aria-hidden="true" />
  }
}

interface PillViewProps {
  pill: OverlayPill
  onStop(): void
  onPointer(over: boolean): void
}

/** One status pill. The text carries the meaning; the badge only backs it up. */
export function PillView({ pill, onStop, onPointer }: PillViewProps) {
  return (
    <div
      key={pill.id}
      className={`pill kind-${pill.kind}`}
      role={pill.kind === 'error' ? 'alert' : 'status'}
      onPointerEnter={() => pill.stoppable && onPointer(true)}
      onPointerLeave={() => pill.stoppable && onPointer(false)}
    >
      <span className="badge">
        <Badge kind={pill.kind} />
      </span>
      <span>{pill.text}</span>
      {pill.stoppable && (
        <button className="stop" type="button" aria-label="중단" onClick={onStop}>
          <X aria-hidden="true" strokeWidth={3} />
        </button>
      )}
    </div>
  )
}
