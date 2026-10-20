import type { OverlayKind, OverlayPill, OverlayState } from '../../shared/contracts/overlay'
import { derivePersistent } from './derive-overlay'
import type { OverlayInputs, PillContent } from './derive-overlay'

/** Where the overlay is drawn. It hides itself when given nothing to show. */
export interface OverlayWindowPort {
  apply(state: OverlayState, displayId: string | null): void
  dispose(): void
}

interface OverlayControllerOptions {
  window: OverlayWindowPort
  /** Returns a cancel function. Injected so display times can be tested without real timers. */
  schedule(callback: () => void, delayMs: number): () => void
  /** How long short-lived pills stay, in ms. */
  durations?: Partial<typeof DURATIONS>
}

const DURATIONS = { done: 2_500, error: 5_000, paused: 3_000, clicking: 600 }
const MAX_TEXT = 60

type Slot = 'voice' | 'gesture'
interface Transient {
  content: PillContent
  cancel: () => void
}

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text)

/**
 * Decides what the overlay shows. Long-lived pills follow the app's state; short-lived ones (a
 * result, an error, a click) cover them for a moment and then give way again. Only changes are
 * sent on, each with a higher revision, and nothing at all is shown while the app is idle.
 */
export class OverlayController {
  private inputs: OverlayInputs = {
    speechPhase: 'idle',
    requestProcessing: false,
    gesture: { phase: 'off', pointing: false }
  }
  private gestureDisplayId: string | null = null
  private paused = false
  private readonly transients: Partial<Record<Slot, Transient>> = {}
  private readonly ids: Record<Slot, { key: string; id: string } | null> = {
    voice: null,
    gesture: null
  }
  private state: OverlayState = { revision: 0, voice: null, gesture: null }
  private counter = 0
  private disposed = false
  private readonly durations: typeof DURATIONS

  constructor(private readonly options: OverlayControllerOptions) {
    this.durations = { ...DURATIONS, ...options.durations }
  }

  getState(): OverlayState {
    return structuredClone(this.state)
  }

  /** The app's own state, as the interaction snapshot reports it. */
  setClientState(client: {
    speechPhase: OverlayInputs['speechPhase']
    requestProcessing: boolean
    gesture: OverlayInputs['gesture'] & { displayId?: string | null }
    recognitionPaused: boolean
  }): void {
    this.inputs = {
      speechPhase: client.speechPhase,
      requestProcessing: client.requestProcessing,
      gesture: { phase: client.gesture.phase, pointing: client.gesture.pointing }
    }
    this.gestureDisplayId = client.gesture.displayId ?? null
    if (client.recognitionPaused && !this.paused)
      this.showTransient('voice', 'paused', '인식 일시 중지', this.durations.paused)
    this.paused = client.recognitionPaused
    this.refresh()
  }

  /** A tool finished: shown as done when it worked, as a problem when it did not. */
  toolResult(ok: boolean, text: string): void {
    if (ok) this.showTransient('voice', 'done', clip(text), this.durations.done)
    else this.showTransient('voice', 'error', clip(text), this.durations.error)
  }

  problem(text: string): void {
    this.showTransient('voice', 'error', clip(text), this.durations.error)
  }

  click(): void {
    this.showTransient('gesture', 'clicking', '클릭', this.durations.clicking)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const slot of ['voice', 'gesture'] as const) this.transients[slot]?.cancel()
    this.options.window.dispose()
  }

  private showTransient(slot: Slot, kind: OverlayKind, text: string, ttlMs: number): void {
    if (this.disposed) return
    this.transients[slot]?.cancel()
    const content: PillContent = { kind, text, stoppable: false }
    const cancel = this.options.schedule(() => {
      delete this.transients[slot]
      this.refresh()
    }, ttlMs)
    this.transients[slot] = { content, cancel }
    this.refresh()
  }

  private refresh(): void {
    if (this.disposed) return
    const persistent = derivePersistent(this.inputs)
    const voice = this.pill('voice', this.transients.voice?.content ?? persistent.voice)
    const gesture = this.pill('gesture', this.transients.gesture?.content ?? persistent.gesture)
    if (
      JSON.stringify({ voice, gesture }) ===
      JSON.stringify({ voice: this.state.voice, gesture: this.state.gesture })
    )
      return
    this.state = { revision: this.state.revision + 1, voice, gesture }
    this.options.window.apply(this.getState(), this.gestureDisplayId)
  }

  /** A pill keeps its ID while it looks the same, so the page can tell "still the same" from "new". */
  private pill(slot: Slot, content: PillContent | null): OverlayPill | null {
    if (!content) {
      this.ids[slot] = null
      return null
    }
    const key = `${content.kind}:${content.text}:${content.stoppable}`
    if (this.ids[slot]?.key !== key) this.ids[slot] = { key, id: `${slot}-${++this.counter}` }
    return { id: this.ids[slot]!.id, ...content }
  }
}
