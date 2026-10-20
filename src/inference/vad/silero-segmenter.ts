import type { DetectedSegment, Segmenter } from './vad-engine'
import type { VadPolicy } from './vad-policy'

/** The subset of sherpa-onnx's `Vad` used here, so a different build can be substituted. */
export interface SherpaVadLike {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  isDetected(): boolean
  front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array }
  pop(): void
  reset(): void
}

export interface SherpaModule {
  Vad: new (config: unknown, bufferSizeInSeconds: number) => SherpaVadLike
}

/** Silero VAD through sherpa-onnx. Segment starts are samples since the last `reset`. */
export class SileroSegmenter implements Segmenter {
  private readonly vad: SherpaVadLike

  constructor(sherpa: SherpaModule, modelPath: string, policy: VadPolicy, sampleRateHz: number) {
    this.vad = new sherpa.Vad(
      {
        sileroVad: {
          model: modelPath,
          threshold: 0.5,
          minSilenceDuration: policy.endSilenceMs / 1000,
          minSpeechDuration: policy.minSpeechMs / 1000,
          windowSize: 512,
          maxSpeechDuration: policy.maxUtteranceMs / 1000
        },
        sampleRate: sampleRateHz,
        numThreads: 1,
        debug: 0
      },
      // Enough for one maximum-length utterance plus slack; older audio lives in the capture buffer.
      Math.ceil(policy.maxUtteranceMs / 1000) + 10
    )
  }

  accept(samples: Float32Array): void {
    this.vad.acceptWaveform(samples)
  }

  isSpeaking(): boolean {
    return this.vad.isDetected()
  }

  takeSegments(): DetectedSegment[] {
    const segments: DetectedSegment[] = []
    while (!this.vad.isEmpty()) {
      const segment = this.vad.front(false)
      segments.push({ start: segment.start, length: segment.samples.length })
      this.vad.pop()
    }
    return segments
  }

  reset(): void {
    this.vad.reset()
  }
}
