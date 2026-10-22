import type { PcmFormat } from '../../../shared/contracts/speech'

/** What the server accepts for an uploaded utterance (REST spec, "음성 데이터 계약"). */
export const SERVER_AUDIO = {
  sampleRateHz: 16_000,
  minSeconds: 0.1,
  maxSeconds: 20,
  /** The whole file, header included. */
  maxBytes: 700_000
} as const

const HEADER_BYTES = 44

/**
 * 16-bit mono PCM wrapped in a WAV header, or null when the server would refuse it: another
 * sample rate, or a length outside what it takes. Checking here spares an upload that cannot work.
 */
export function encodeWav(pcm: Uint8Array, format: PcmFormat): Uint8Array | null {
  if (format.encoding !== 'pcm_s16le' || format.channels !== 1) return null
  if (format.sampleRateHz !== SERVER_AUDIO.sampleRateHz) return null
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) return null
  const seconds = pcm.byteLength / 2 / format.sampleRateHz
  if (seconds < SERVER_AUDIO.minSeconds || seconds > SERVER_AUDIO.maxSeconds) return null
  if (HEADER_BYTES + pcm.byteLength > SERVER_AUDIO.maxBytes) return null

  const wav = new Uint8Array(HEADER_BYTES + pcm.byteLength)
  const view = new DataView(wav.buffer)
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1)
      wav[offset + index] = value.charCodeAt(index)
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true) // size of the format block
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, format.sampleRateHz, true)
  view.setUint32(28, format.sampleRateHz * 2, true) // bytes per second
  view.setUint16(32, 2, true) // bytes per sample frame
  view.setUint16(34, 16, true) // bits per sample
  text(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  wav.set(pcm, HEADER_BYTES)
  return wav
}
