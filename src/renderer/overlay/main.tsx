import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EMPTY_OVERLAY } from '../../shared/contracts/overlay'
import type { OverlayState } from '../../shared/contracts/overlay'
import { PillView } from './pill'
import './overlay.css'

function Overlay(): React.JSX.Element {
  const [state, setState] = useState<OverlayState>(EMPTY_OVERLAY)
  const api = window.jarvisOverlay

  useEffect(() => {
    if (!api) return
    let active = true
    const unsubscribe = api.subscribe((next) => {
      if (active) setState((current) => (next.revision >= current.revision ? next : current))
    })
    void api.getState().then((first) => {
      if (active) setState((current) => (first.revision >= current.revision ? first : current))
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [api])

  const onPointer = (over: boolean) => api?.setInteractive(over)
  return (
    <div className="stage">
      {state.voice && (
        <div className="slot slot-voice">
          <PillView
            key={state.voice.id}
            pill={state.voice}
            onStop={() => api?.stop()}
            onPointer={onPointer}
          />
        </div>
      )}
      {state.gesture && (
        <div className="slot slot-gesture">
          <PillView
            key={state.gesture.id}
            pill={state.gesture}
            onStop={() => api?.stop()}
            onPointer={onPointer}
          />
        </div>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Overlay />
  </React.StrictMode>
)
