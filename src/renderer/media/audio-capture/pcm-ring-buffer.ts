/**
 * Bounded history of 16-bit PCM addressed by absolute sample index (the first sample ever
 * appended is 0). Old samples are dropped once capacity is exceeded; asking for a range that was
 * dropped, cleared or not yet captured fails instead of returning something else.
 */
export class PcmRingBuffer {
  private readonly data: Int16Array
  /** Absolute index of the next sample to be written. */
  private end = 0
  /** Absolute index of the oldest sample still held. */
  private start = 0

  constructor(readonly capacitySamples: number) {
    if (!Number.isInteger(capacitySamples) || capacitySamples <= 0)
      throw new RangeError('capacitySamples must be a positive integer')
    this.data = new Int16Array(capacitySamples)
  }

  /** Index of the next sample; also how many samples have been captured so far. */
  get endSample(): number {
    return this.end
  }

  get startSample(): number {
    return this.start
  }

  /** Appends samples and returns the absolute index of the first one. */
  append(samples: Int16Array): number {
    const first = this.end
    // Only the newest `capacity` samples can be kept; indices still advance for all of them.
    const keep =
      samples.length > this.capacitySamples
        ? samples.subarray(samples.length - this.capacitySamples)
        : samples
    const keepFrom = this.end + (samples.length - keep.length)
    let offset = keepFrom % this.capacitySamples
    for (let i = 0; i < keep.length; i++) {
      this.data[offset] = keep[i]
      offset = offset + 1 === this.capacitySamples ? 0 : offset + 1
    }
    this.end += samples.length
    this.start = Math.max(this.start, this.end - this.capacitySamples)
    return first
  }

  /** Copy of `[startSample, startSample + count)`, or null if any of it is unavailable. */
  read(startSample: number, count: number): Int16Array | null {
    if (!Number.isInteger(startSample) || !Number.isInteger(count) || count <= 0) return null
    if (startSample < this.start || startSample + count > this.end) return null
    const out = new Int16Array(count)
    let offset = startSample % this.capacitySamples
    for (let i = 0; i < count; i++) {
      out[i] = this.data[offset]
      offset = offset + 1 === this.capacitySamples ? 0 : offset + 1
    }
    return out
  }

  /** Drops everything held. Indices keep counting, so older ranges can never be returned again. */
  clear(): void {
    this.start = this.end
    this.data.fill(0)
  }
}
