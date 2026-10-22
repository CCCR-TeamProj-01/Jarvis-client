import { describe, expect, it } from 'vitest'
import { SERVER_AUDIO, encodeWav } from '../../src/main/speech/remote-speech/wav'
import type { PcmFormat } from '../../src/shared/contracts/speech'

const FORMAT: PcmFormat = { encoding: 'pcm_s16le', sampleRateHz: 16_000, channels: 1 }
const samples = (count: number) => {
  const pcm = new Uint8Array(count * 2)
  for (let index = 0; index < pcm.length; index += 1) pcm[index] = index % 251
  return pcm
}

describe('encodeWav', () => {
  it('wraps the samples in a header the server reads as 16 kHz, mono, 16-bit PCM', () => {
    const pcm = samples(16_000)
    const wav = encodeWav(pcm, FORMAT)!
    const view = new DataView(wav.buffer)
    const text = (offset: number, length: number) =>
      String.fromCharCode(...wav.subarray(offset, offset + length))
    expect(text(0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8)
    expect(text(8, 4)).toBe('WAVE')
    expect(text(12, 4)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(28, true)).toBe(32_000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(text(36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(pcm.byteLength)
    expect(wav.byteLength).toBe(44 + pcm.byteLength)
  })

  it('keeps the samples exactly as they were', () => {
    const pcm = samples(3200)
    const wav = encodeWav(pcm, FORMAT)!
    expect(wav.subarray(44)).toEqual(pcm)
  })

  it('does not change what it was given', () => {
    const pcm = samples(3200)
    const copy = pcm.slice()
    encodeWav(pcm, FORMAT)
    expect(pcm).toEqual(copy)
  })

  it('takes the shortest and the longest the server takes', () => {
    expect(encodeWav(samples(1600), FORMAT)).not.toBeNull() // 0.1 s
    expect(encodeWav(samples(16_000 * 20), FORMAT)).not.toBeNull() // 20 s
  })

  it('refuses what is too short or too long', () => {
    expect(encodeWav(samples(1599), FORMAT)).toBeNull()
    expect(encodeWav(samples(0), FORMAT)).toBeNull()
    expect(encodeWav(samples(16_000 * 20 + 1), FORMAT)).toBeNull()
  })

  it('keeps the whole file within the byte limit', () => {
    const longest = encodeWav(samples(16_000 * 20), FORMAT)!
    expect(longest.byteLength).toBeLessThanOrEqual(SERVER_AUDIO.maxBytes)
  })

  it('refuses another sample rate, channel count or encoding', () => {
    expect(encodeWav(samples(16_000), { ...FORMAT, sampleRateHz: 44_100 })).toBeNull()
    expect(encodeWav(samples(16_000), { ...FORMAT, sampleRateHz: 8000 })).toBeNull()
    expect(
      encodeWav(samples(16_000), { ...FORMAT, channels: 2 } as unknown as PcmFormat)
    ).toBeNull()
    expect(
      encodeWav(samples(16_000), { ...FORMAT, encoding: 'f32' } as unknown as PcmFormat)
    ).toBeNull()
  })

  it('refuses a half sample', () => {
    expect(encodeWav(new Uint8Array(3201), FORMAT)).toBeNull()
  })
})
