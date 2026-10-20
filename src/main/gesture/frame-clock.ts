/**
 * Frames are stamped with the Media Renderer's clock, whose zero differs from Main's. The two
 * cannot be compared directly, so the offset is estimated as the smallest difference seen lately
 * (the frame that travelled fastest) and a frame's age is how much slower than that it was.
 */
export class FrameClock {
  private readonly recent: number[] = []

  constructor(private readonly windowSize = 120) {}

  reset(): void {
    this.recent.length = 0
  }

  /** Records the frame and returns how long it waited, in ms (never negative). */
  age(capturedAtMs: number, nowMs: number): number {
    const difference = nowMs - capturedAtMs
    this.recent.push(difference)
    if (this.recent.length > this.windowSize) this.recent.shift()
    return Math.max(0, difference - Math.min(...this.recent))
  }
}
