import { describe, expect, it } from 'vitest'
import { CaptureSession } from '../../src/renderer/media/audio-capture/capture-session'
import type { PcmChunk } from '../../src/shared/contracts/speech'

const format = { encoding: 'pcm_s16le', sampleRateHz: 1000, channels: 1 } as const
const generation = { sessionId: 's', revision: 0 }

function setup(bufferSeconds = 10, chunkMs = 100) {
  const chunks: PcmChunk[] = []
  const session = new CaptureSession({
    generation,
    format,
    bufferSeconds,
    chunkMs,
    emit: (chunk) => chunks.push(chunk)
  })
  return { session, chunks }
}
const ramp = (from: number, count: number) =>
  Float32Array.from({ length: count }, (_, i) => (from + i) / 32768)
const samplesOf = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: bytes.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true))
}

describe('CaptureSession', () => {
  it('emits gap-free chunks of the configured size with running sequence and sample numbers', () => {
    const { session, chunks } = setup()
    session.ingest(ramp(0, 70))
    session.ingest(ramp(70, 150))
    expect(chunks.map((c) => [c.sequence, c.startSample, c.audio.byteLength])).toEqual([
      [0, 0, 200],
      [1, 100, 200]
    ])
    expect(chunks.every((c) => c.generation === generation && c.format === format)).toBe(true)
    expect(samplesOf(chunks[1].audio)).toEqual(Array.from({ length: 100 }, (_, i) => 100 + i))
  })

  it('writes samples little endian', () => {
    const { session, chunks } = setup(10, 100)
    session.ingest(Float32Array.from({ length: 100 }, () => 0x0102 / 32768))
    expect(Array.from(chunks[0].audio.slice(0, 2))).toEqual([0x02, 0x01])
  })

  it('extracts exactly the requested range, using the same numbering as the chunks', () => {
    const { session } = setup()
    session.ingest(ramp(0, 500))
    const result = session.extract({
      utteranceId: 'u1',
      generation,
      startSample: 120,
      sampleCount: 200
    })
    expect(result).toMatchObject({
      ok: true,
      value: { utteranceId: 'u1', startSample: 120, sampleCount: 200, format }
    })
    if (!result.ok) return
    expect(result.value.audio.byteLength).toBe(400)
    expect(samplesOf(result.value.audio)).toEqual(Array.from({ length: 200 }, (_, i) => 120 + i))
  })

  it('can extract audio that has not been sent as a chunk yet', () => {
    const { session, chunks } = setup()
    session.ingest(ramp(0, 150))
    expect(chunks).toHaveLength(1)
    expect(
      session.extract({ utteranceId: 'u', generation, startSample: 100, sampleCount: 50 }).ok
    ).toBe(true)
  })

  it('refuses ranges that were evicted, never captured or cleared', () => {
    const { session } = setup(1, 100)
    session.ingest(ramp(0, 1500))
    expect(
      session.extract({ utteranceId: 'a', generation, startSample: 0, sampleCount: 100 })
    ).toMatchObject({
      ok: false,
      error: { code: 'not_found' }
    })
    expect(
      session.extract({ utteranceId: 'b', generation, startSample: 1400, sampleCount: 200 })
    ).toMatchObject({
      ok: false
    })
    session.clear()
    expect(
      session.extract({ utteranceId: 'c', generation, startSample: 1450, sampleCount: 40 })
    ).toMatchObject({
      ok: false
    })
  })

  it('keeps streaming and numbering after the history is cleared', () => {
    const { session, chunks } = setup()
    session.ingest(ramp(0, 100))
    session.clear()
    session.ingest(ramp(100, 100))
    expect(chunks.map((c) => c.startSample)).toEqual([0, 100])
    expect(
      session.extract({ utteranceId: 'x', generation, startSample: 100, sampleCount: 100 }).ok
    ).toBe(true)
  })

  it('rejects an extraction that belongs to another capture', () => {
    const { session } = setup()
    session.ingest(ramp(0, 100))
    expect(
      session.extract({
        utteranceId: 'y',
        generation: { sessionId: 'other', revision: 0 },
        startSample: 0,
        sampleCount: 10
      })
    ).toMatchObject({ ok: false, error: { code: 'conflict' } })
  })

  it('discards everything on dispose', () => {
    const { session } = setup()
    session.ingest(ramp(0, 100))
    session.dispose()
    expect(
      session.extract({ utteranceId: 'z', generation, startSample: 0, sampleCount: 10 }).ok
    ).toBe(false)
  })
})
