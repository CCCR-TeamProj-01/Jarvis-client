/** A short sine tone as a 16-bit mono WAV, used as the stand-in "spoken" reply. */
export function createToneWav(options: {
  frequencyHz?: number
  durationMs?: number
  sampleRateHz?: number
  volume?: number
}): Uint8Array {
  const rate = options.sampleRateHz ?? 16_000
  const count = Math.round((rate * (options.durationMs ?? 400)) / 1000)
  const frequency = options.frequencyHz ?? 523.25
  const volume = options.volume ?? 0.2
  const bytes = new Uint8Array(44 + count * 2)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + count * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, count * 2, true)
  for (let i = 0; i < count; i++) {
    // Short fade in/out so the tone does not click.
    const edge = Math.min(1, i / 400, (count - i) / 400)
    const sample = Math.sin((2 * Math.PI * frequency * i) / rate) * volume * edge
    view.setInt16(44 + i * 2, Math.round(sample * 0x7fff), true)
  }
  return bytes
}
