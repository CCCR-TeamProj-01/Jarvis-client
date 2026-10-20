/** Float32 [-1, 1] to signed 16-bit, clamped. */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    out[i] = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff)
  }
  return out
}

/**
 * Regroups the small, irregular blocks an audio callback delivers into fixed-size chunks, so
 * IPC traffic is steady (for example 100 ms) whatever the callback size is.
 */
export class PcmFramer {
  private pending = new Int16Array(0)

  constructor(private readonly chunkSamples: number) {
    if (!Number.isInteger(chunkSamples) || chunkSamples <= 0)
      throw new RangeError('chunkSamples must be a positive integer')
  }

  push(samples: Int16Array): Int16Array[] {
    const merged = new Int16Array(this.pending.length + samples.length)
    merged.set(this.pending)
    merged.set(samples, this.pending.length)
    const chunks: Int16Array[] = []
    let offset = 0
    while (merged.length - offset >= this.chunkSamples) {
      chunks.push(merged.slice(offset, offset + this.chunkSamples))
      offset += this.chunkSamples
    }
    this.pending = merged.slice(offset)
    return chunks
  }

  /** Samples waiting for a full chunk. They are discarded on stop, never sent partially. */
  get pendingSamples(): number {
    return this.pending.length
  }

  reset(): void {
    this.pending = new Int16Array(0)
  }
}
