export interface OneEuroParams {
  minCutoffHz: number
  beta: number
  derivativeCutoffHz: number
}

const smoothingFactor = (cutoffHz: number, deltaSeconds: number) => {
  const tau = 1 / (2 * Math.PI * cutoffHz)
  return 1 / (1 + tau / deltaSeconds)
}

class Channel {
  private value: number | null = null
  private derivative = 0

  constructor(private readonly params: OneEuroParams) {}

  reset(): void {
    this.value = null
    this.derivative = 0
  }

  filter(input: number, deltaSeconds: number): number {
    if (this.value === null) {
      this.value = input
      return input
    }
    const rawDerivative = (input - this.value) / deltaSeconds
    this.derivative +=
      smoothingFactor(this.params.derivativeCutoffHz, deltaSeconds) *
      (rawDerivative - this.derivative)
    const cutoff = this.params.minCutoffHz + this.params.beta * Math.abs(this.derivative)
    this.value += smoothingFactor(cutoff, deltaSeconds) * (input - this.value)
    return this.value
  }
}

/** Two-dimensional One Euro filter (Casiez et al.): low jitter at rest, little lag in motion. */
export class OneEuroFilter2D {
  private readonly x: Channel
  private readonly y: Channel
  private lastTimeMs: number | null = null

  constructor(params: OneEuroParams) {
    this.x = new Channel(params)
    this.y = new Channel(params)
  }

  reset(): void {
    this.x.reset()
    this.y.reset()
    this.lastTimeMs = null
  }

  filter(point: { x: number; y: number }, timeMs: number): { x: number; y: number } {
    // Time must move forward; a repeated or reversed stamp reuses a small step instead.
    const deltaSeconds =
      this.lastTimeMs === null ? 1 / 30 : Math.max((timeMs - this.lastTimeMs) / 1000, 0.001)
    this.lastTimeMs = timeMs
    return { x: this.x.filter(point.x, deltaSeconds), y: this.y.filter(point.y, deltaSeconds) }
  }
}
