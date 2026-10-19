import type { Generation } from '../../src/shared/contracts/common'
import type { HandTrackingFrame } from '../../src/shared/contracts/gesture'
import type { CompletedUtterance, PcmChunk, PcmFormat } from '../../src/shared/contracts/speech'

export const generation: Generation = { sessionId: 'session-1', revision: 1 }
export const pcmFormat: PcmFormat = { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }

export function trackingFrame(overrides: Partial<HandTrackingFrame> = {}): HandTrackingFrame {
  return {
    generation,
    sequence: 1,
    capturedAtMs: 100,
    hands: [
      {
        handId: 'hand-1',
        handedness: 'right',
        confidence: 0.9,
        landmarks: Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: -0.1 }))
      }
    ],
    ...overrides
  }
}

export function pcmChunk(overrides: Partial<PcmChunk> = {}): PcmChunk {
  return {
    generation,
    sequence: 0,
    startSample: 0,
    format: pcmFormat,
    audio: new Uint8Array(320),
    ...overrides
  }
}

export function utterance(overrides: Partial<CompletedUtterance> = {}): CompletedUtterance {
  return {
    utteranceId: 'utterance-1',
    generation,
    startSample: 0,
    sampleCount: 160,
    format: pcmFormat,
    audio: new Uint8Array(320),
    ...overrides
  }
}
