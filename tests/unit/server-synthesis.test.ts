import { describe, expect, it, vi } from 'vitest'
import type { ServerClient } from '../../src/main/connection/server-client'
import {
  MAX_SPOKEN_CHARS,
  ServerSynthesizer,
  speakableText
} from '../../src/main/speech/remote-speech/server-synthesis'

describe('speakableText', () => {
  it('leaves a short answer as it is, without the spaces around it', () => {
    expect(speakableText('  열었어요.  ')).toBe('열었어요.')
  })

  it('takes an answer exactly at the limit whole', () => {
    const text = '가'.repeat(MAX_SPOKEN_CHARS)
    expect(speakableText(text)).toBe(text)
  })

  it('cuts a long answer after the last whole sentence that fits', () => {
    const first = `${'가'.repeat(150)}.`
    const second = `${'나'.repeat(120)}.`
    const text = `${first} ${second} ${'다'.repeat(100)}.`
    expect(speakableText(text)).toBe(`${first} ${second}`)
  })

  it('cuts at the limit when there is no sentence end to cut at', () => {
    const spoken = speakableText('가'.repeat(MAX_SPOKEN_CHARS + 50))
    expect([...spoken]).toHaveLength(MAX_SPOKEN_CHARS)
  })

  it('does not cut after a sentence end that leaves almost nothing', () => {
    const spoken = speakableText(`네. ${'가'.repeat(400)}`)
    expect([...spoken]).toHaveLength(MAX_SPOKEN_CHARS)
  })

  it('counts a character as the server does, so an emoji is one', () => {
    const text = '😀'.repeat(MAX_SPOKEN_CHARS + 5)
    expect([...speakableText(text)]).toHaveLength(MAX_SPOKEN_CHARS)
    expect(speakableText('😀'.repeat(MAX_SPOKEN_CHARS))).toBe('😀'.repeat(MAX_SPOKEN_CHARS))
  })

  it('does not cut an answer that fits when counted by characters but not by code units', () => {
    // 251 characters, 502 UTF-16 units: it fits, so it is read whole, sentence end and all.
    const text = `${'😀'.repeat(150)}.${'😀'.repeat(100)}`
    expect(speakableText(text)).toBe(text)
  })

  it('also ends a sentence at a question mark, an exclamation mark or a line break', () => {
    for (const mark of ['?', '!', '\n']) {
      const first = `${'가'.repeat(200)}${mark}`
      const spoken = speakableText(`${first}${'나'.repeat(200)}`)
      expect(spoken).toBe(first.trim())
    }
  })
})

describe('ServerSynthesizer', () => {
  function clientAnswering(result: unknown) {
    const requestBytes = vi.fn<(request: unknown) => Promise<unknown>>(async () => result)
    return { client: { requestBytes } as unknown as ServerClient, requestBytes }
  }

  it('asks for MP3 of the sentence and returns the bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const { client, requestBytes } = clientAnswering({
      ok: true,
      value: { bytes, mimeType: 'audio/mpeg' },
      status: 200
    })
    const result = await new ServerSynthesizer(client).synthesize('열었어요')
    expect(result).toEqual({ ok: true, value: { bytes, mimeType: 'audio/mpeg' } })
    expect(requestBytes).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: 'POST',
        path: '/speech/syntheses',
        body: { text: '열었어요' },
        accept: 'audio/mpeg'
      })
    )
  })

  it('sends only what can be spoken', async () => {
    const { client, requestBytes } = clientAnswering({
      ok: true,
      value: { bytes: new Uint8Array([1]), mimeType: 'audio/mpeg' },
      status: 200
    })
    await new ServerSynthesizer(client).synthesize('가'.repeat(500))
    const sent = (requestBytes.mock.calls as unknown as [{ body: { text: string } }][])[0]![0]
    expect([...sent.body.text]).toHaveLength(MAX_SPOKEN_CHARS)
  })

  it('does not call the server for nothing to say', async () => {
    const { client, requestBytes } = clientAnswering({})
    expect(await new ServerSynthesizer(client).synthesize('   ')).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' }
    })
    expect(requestBytes).not.toHaveBeenCalled()
  })

  it('passes a failure on as it is', async () => {
    const error = { code: 'unavailable', message: '서버에 연결하지 못했어요.' }
    const { client } = clientAnswering({
      ok: false,
      error,
      detail: { delivery: 'responded', status: 502 }
    })
    expect(await new ServerSynthesizer(client).synthesize('네')).toEqual({ ok: false, error })
  })

  it('hands the cancel signal on', async () => {
    const abort = new AbortController()
    const { client, requestBytes } = clientAnswering({
      ok: true,
      value: { bytes: new Uint8Array([1]), mimeType: 'audio/mpeg' },
      status: 200
    })
    await new ServerSynthesizer(client).synthesize('네', abort.signal)
    expect(requestBytes).toHaveBeenCalledWith(expect.objectContaining({ signal: abort.signal }))
  })
})
