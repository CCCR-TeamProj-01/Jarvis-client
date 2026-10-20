import { describe, expect, it } from 'vitest'
import {
  CompletedUtteranceSchema,
  PcmChunkSchema,
  PlaybackEventSchema,
  PlaybackRequestSchema,
  SpeechSnapshotSchema,
  WakeWordEventSchema,
  isContiguousPcm,
  utteranceDurationMs
} from '../../src/shared/contracts/speech'
import { generation, pcmChunk, utterance } from '../fixtures/contracts'

describe('local PCM and utterances', () => {
  it('derives duration from the actual sample count', () => {
    const value = CompletedUtteranceSchema.parse(utterance())
    expect(utteranceDurationMs(value)).toBe(10)
    expect(value).not.toHaveProperty('context')
  })

  it.each([new Uint8Array(0), new Uint8Array(1), new Uint8Array(321)])(
    'rejects empty or incomplete 16-bit chunks',
    (audio) => {
      expect(PcmChunkSchema.safeParse(pcmChunk({ audio })).success).toBe(false)
    }
  )

  it.each([undefined, null, [], new Float32Array(160), 'audio'].map((audio) => ({ audio })))(
    'rejects non-byte payloads $audio',
    ({ audio }) => {
      expect(CompletedUtteranceSchema.safeParse({ ...utterance(), audio }).success).toBe(false)
    }
  )

  it('rejects mismatched lengths, empty segments and speculative remote metadata', () => {
    expect(CompletedUtteranceSchema.safeParse(utterance({ sampleCount: 159 })).success).toBe(false)
    expect(
      CompletedUtteranceSchema.safeParse(utterance({ sampleCount: 0, audio: new Uint8Array(0) }))
        .success
    ).toBe(false)
    expect(CompletedUtteranceSchema.safeParse({ ...utterance(), protocolVersion: 1 }).success).toBe(
      false
    )
    expect(
      CompletedUtteranceSchema.safeParse({
        ...utterance(),
        format: { encoding: 'pcm_s16le', channels: 1, sampleRateHz: 0 }
      }).success
    ).toBe(false)
  })

  it('requires contiguous sequences, samples, generations and sample rates', () => {
    const first = pcmChunk()
    const next = pcmChunk({ sequence: 1, startSample: 160 })
    expect(isContiguousPcm(first, next)).toBe(true)
    expect(isContiguousPcm(first, { ...next, sequence: 2 })).toBe(false)
    expect(isContiguousPcm(first, { ...next, startSample: 161 })).toBe(false)
    expect(isContiguousPcm(first, { ...next, generation: { ...generation, revision: 2 } })).toBe(
      false
    )
    expect(
      isContiguousPcm(first, { ...next, format: { ...next.format, sampleRateHz: 8000 } })
    ).toBe(false)
  })

  it('rejects reversed wake-word boundaries', () => {
    expect(
      WakeWordEventSchema.safeParse({
        generation,
        keyword: '자비스',
        keywordStartSample: 100,
        keywordEndSample: 50,
        detectedAtSample: 200
      }).success
    ).toBe(false)
  })

  it('requires the active speech generation and clears it when idle', () => {
    expect(SpeechSnapshotSchema.safeParse({ phase: 'speaking', generation: null }).success).toBe(
      false
    )
    expect(SpeechSnapshotSchema.safeParse({ phase: 'speaking', generation }).success).toBe(true)
    expect(SpeechSnapshotSchema.safeParse({ phase: 'idle', generation }).success).toBe(false)
  })
})

describe('playback boundary', () => {
  const playback = {
    playbackId: 'play-1',
    generation,
    mimeType: 'audio/wav',
    audio: new Uint8Array(10)
  }

  it('requires nonempty audio with an audio MIME type', () => {
    expect(PlaybackRequestSchema.safeParse(playback).success).toBe(true)
    expect(PlaybackRequestSchema.safeParse({ ...playback, mimeType: 'text/html' }).success).toBe(
      false
    )
    expect(PlaybackRequestSchema.safeParse({ ...playback, audio: new Uint8Array(0) }).success).toBe(
      false
    )
  })

  it('keeps stopped playback distinct from completion and requires failure details', () => {
    expect(
      PlaybackEventSchema.parse({ type: 'playback.stopped', generation, playbackId: 'play-1' }).type
    ).toBe('playback.stopped')
    expect(
      PlaybackEventSchema.safeParse({ type: 'playback.failed', generation, playbackId: 'play-1' })
        .success
    ).toBe(false)
  })
})
