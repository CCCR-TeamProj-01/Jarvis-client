import type { AuthPort } from '../auth/auth-manager'
import type { HandTrackingService } from './hand-tracking'
import { fingerExtensions } from './finger-pose'
import { pinchRatio } from './pinch-detector'

const generation = { sessionId: 'hand-selftest', revision: 0 }

/**
 * Development only (unpackaged app with JARVIS_HAND_SELFTEST=<seconds>): once signed in, track
 * hands for that long (0 = until sign-out or quit) and log what was seen, so the real camera → worker → Main path can be
 * exercised without the gesture controller. With Chromium's fake camera playing a video of a hand
 * this shows the whole pipeline working.
 */
export function startHandSelfTest(
  seconds: number,
  auth: Pick<AuthPort, 'subscribe'>,
  tracking: Pick<HandTrackingService, 'start' | 'stop' | 'subscribe'>,
  log: (line: string) => void = console.log
): () => void {
  const print = (label: string, value: unknown) =>
    log(`HAND_SELFTEST ${label} ${JSON.stringify(value)}`)
  let frames = 0
  let withHands = 0
  let timer: NodeJS.Timeout | null = null
  const stopEvents = tracking.subscribe((event) => {
    if (event.type === 'tracking.lost') return print('lost', event)
    frames += 1
    if (event.frame.hands.length > 0) withHands += 1
    if (frames === 1 || frames % 30 === 0)
      print('frame', {
        sequence: event.frame.sequence,
        hands: event.frame.hands.map((hand) => ({
          handId: hand.handId,
          handedness: hand.handedness,
          confidence: Number(hand.confidence.toFixed(2)),
          pinch: Number((pinchRatio(hand) ?? -1).toFixed(2)),
          // How far each finger reaches (index, middle, ring, pinky): about 2 stretched, under 1 curled.
          reach: Object.values(fingerExtensions(hand) ?? {}).map((value) =>
            Number(value.toFixed(2))
          ),
          indexTip: {
            x: Number(hand.landmarks[8].x.toFixed(3)),
            y: Number(hand.landmarks[8].y.toFixed(3))
          }
        }))
      })
  })
  const run = async () => {
    const started = Date.now()
    const result = await tracking.start(generation)
    if (!result.ok) return print('error', result.error)
    print('started', { startupMs: Date.now() - started })
    if (seconds === 0) return
    timer = setTimeout(() => {
      void tracking.stop().then(() => print('done', { frames, withHands }))
    }, seconds * 1000)
  }
  const stopAuth = auth.subscribe((event) => {
    if (event.type === 'auth.state_changed' && event.snapshot.phase === 'signed_in')
      void run().catch((error: unknown) => print('error', String(error)))
  })
  return () => {
    if (timer) clearTimeout(timer)
    stopAuth()
    stopEvents()
  }
}
