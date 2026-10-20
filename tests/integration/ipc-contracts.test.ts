import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { resultSchema } from '../../src/shared/contracts/common'
import { AuthEventSchema, SignInRequestSchema } from '../../src/shared/contracts/auth'
import {
  CheckLoginIdResponseSchema,
  SignInResponseSchema,
  SignUpResponseSchema
} from '../../src/shared/ipc/auth-api'
import { UiCommandSchema } from '../../src/shared/contracts/interaction'
import { MediaCommandEnvelopeSchema, MediaEventSchema } from '../../src/shared/ipc/media-api'
import { authGeneration, authUser, generation, utterance } from '../fixtures/contracts'

describe('structured-clone IPC contract boundaries', () => {
  it('round-trips completed audio independently of its original buffer', () => {
    const original = { type: 'audio.utterance', utterance: utterance() }
    original.utterance.audio[0] = 42
    const cloned: unknown = structuredClone(original)
    const event = MediaEventSchema.parse(cloned)
    if (event.type !== 'audio.utterance') throw new Error('Unexpected event type')
    original.utterance.audio[0] = 0
    expect(event.utterance.audio).toBeInstanceOf(Uint8Array)
    expect(event.utterance.audio[0]).toBe(42)
    expect(event.utterance).not.toHaveProperty('conversationId')
  })

  it('does not accept media operations or local control objects through the UI contract', () => {
    const command = { type: 'audio.buffer.clear', generation }
    expect(MediaCommandEnvelopeSchema.safeParse({ commandId: 'cmd-1', command }).success).toBe(true)
    expect(UiCommandSchema.safeParse(command).success).toBe(false)
    expect(
      MediaCommandEnvelopeSchema.safeParse({
        commandId: 'cmd-1',
        command,
        signal: new AbortController().signal
      }).success
    ).toBe(false)
  })

  it('returns typed error data and rejects arbitrary error stacks', () => {
    const schema = resultSchema(z.null())
    const failure = {
      ok: false,
      error: { code: 'permission_denied', message: 'Camera permission denied' }
    }
    expect(schema.parse(structuredClone(failure))).toEqual(failure)
    expect(
      schema.safeParse({
        ...failure,
        error: { ...failure.error, stack: 'not renderer data' }
      }).success
    ).toBe(false)
  })

  it('requires details for failed capture and camera events', () => {
    for (const type of ['camera.state', 'audio.capture.state']) {
      expect(MediaEventSchema.safeParse({ type, generation, state: 'failed' }).success).toBe(false)
      expect(
        MediaEventSchema.safeParse({
          type,
          generation,
          state: 'failed',
          error: { code: 'device_unavailable', message: 'Device disconnected' }
        }).success
      ).toBe(true)
    }
  })

  it('isolates authentication input from general UI commands and local control objects', () => {
    const request = {
      requestId: 'login-1',
      generation: authGeneration,
      input: { loginId: 'tester', password: 'example-password' }
    }
    expect(SignInRequestSchema.parse(structuredClone(request))).toEqual(request)
    expect(UiCommandSchema.safeParse(request).success).toBe(false)
    expect(
      SignInRequestSchema.safeParse({ ...request, signal: new AbortController().signal }).success
    ).toBe(false)
  })

  it('round-trips public auth state while refusing tokens in results and media events', () => {
    const result = {
      ok: true,
      value: {
        snapshot: { phase: 'signed_in', generation: authGeneration, user: authUser },
        persistence: { status: 'stored' }
      }
    }
    expect(SignInResponseSchema.parse(structuredClone(result))).toEqual(result)
    expect(
      SignInResponseSchema.safeParse({
        ...result,
        value: { ...result.value, accessToken: 'secret' }
      }).success
    ).toBe(false)
    const event = { type: 'auth.state_changed', snapshot: result.value.snapshot }
    expect(AuthEventSchema.parse(structuredClone(event))).toEqual(event)
    expect(MediaEventSchema.safeParse(event).success).toBe(false)
    expect(
      SignUpResponseSchema.safeParse({
        ok: true,
        value: { loginId: 'tester', passwordHash: 'secret' }
      }).success
    ).toBe(false)
  })

  it('keeps failed duplicate checks distinct from an available or taken login ID', () => {
    for (const available of [true, false]) {
      expect(
        CheckLoginIdResponseSchema.safeParse({ ok: true, value: { loginId: 'tester', available } })
          .success
      ).toBe(true)
    }
    const failure = {
      ok: false,
      error: { code: 'unavailable', message: 'Authentication service unavailable' }
    }
    expect(CheckLoginIdResponseSchema.parse(structuredClone(failure))).toEqual(failure)
    expect(
      CheckLoginIdResponseSchema.safeParse({
        ...failure,
        error: { ...failure.error, token: 'secret' }
      }).success
    ).toBe(false)
  })
})
