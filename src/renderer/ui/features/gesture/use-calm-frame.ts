import { useEffect, useRef, useState } from 'react'
import type { DiagnosticsFrame } from '../../../../shared/contracts/gesture-diagnostics'
import { CALM_INTERVAL_MS, calmNext } from './recognition-model'
import type { CalmFrame } from './recognition-model'

/**
 * The frame the cards and numbers show: the newest one, but changing at most a few times a second.
 * Frames come twenty or thirty times a second, and digits and labels that flip that often cannot
 * be read and hurt to look at; the picture and the hands drawn on it keep the full rate.
 */
export function useCalmFrame(frame: DiagnosticsFrame | null): CalmFrame | null {
  const [shown, setShown] = useState<CalmFrame | null>(null)
  const latest = useRef<DiagnosticsFrame | null>(null)
  const current = useRef<CalmFrame | null>(null)
  const lastAt = useRef(Number.NEGATIVE_INFINITY)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    latest.current = frame
    if (!frame) {
      // Nothing is shown, and what comes next starts afresh.
      current.current = null
      lastAt.current = Number.NEGATIVE_INFINITY
      return
    }
    // A change is already on its way and will take whatever is newest by then.
    if (timer.current !== undefined) return
    const wait = Math.max(0, CALM_INTERVAL_MS - (performance.now() - lastAt.current))
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      const incoming = latest.current
      if (!incoming) return
      const now = performance.now()
      lastAt.current = now
      current.current = calmNext(current.current, incoming, now)
      setShown(current.current)
    }, wait)
  }, [frame])

  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      timer.current = undefined
    },
    []
  )
  // Until the first change comes through, the first frame is shown as it is, so nothing waits.
  return frame ? (shown ?? { frame, lostSinceMs: null }) : null
}
