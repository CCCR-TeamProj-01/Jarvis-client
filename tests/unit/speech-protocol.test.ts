import { describe, expect, it } from 'vitest'
import { SPEECH_PROTOCOL_VERSION } from '../../src/shared/speech-protocol'

describe('speech-protocol', () => {
  it('exposes a positive integer protocol version', () => {
    expect(Number.isInteger(SPEECH_PROTOCOL_VERSION)).toBe(true)
    expect(SPEECH_PROTOCOL_VERSION).toBeGreaterThan(0)
  })
})
