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

  it('carries hand tracking through the media contract and rejects malformed use', () => {
    const start = {
      type: 'handtracking.start',
      request: { generation, model: new Uint8Array([1, 2, 3]), maxFps: 30 }
    }
    const parsed = MediaCommandEnvelopeSchema.parse(
      structuredClone({ commandId: 'c', command: start })
    )
    expect(parsed.command).toMatchObject({ type: 'handtracking.start' })
    for (const request of [
      { generation, model: new Uint8Array() },
      { generation, model: 'file:///model.task' },
      { generation, model: new Uint8Array([1]), maxFps: 0 },
      { generation, model: new Uint8Array([1]), maxFps: 120 },
      { generation, model: new Uint8Array([1]), path: '/etc/passwd' }
    ])
      expect(
        MediaCommandEnvelopeSchema.safeParse({
          commandId: 'c',
          command: { type: 'handtracking.start', request }
        }).success
      ).toBe(false)

    const frame = {
      type: 'hand.tracking',
      event: {
        type: 'tracking.frame',
        frame: { generation, sequence: 1, capturedAtMs: 1, hands: [] }
      }
    }
    expect(MediaEventSchema.safeParse(structuredClone(frame)).success).toBe(true)
    expect(
      MediaEventSchema.safeParse({ type: 'handtracking.state', generation, state: 'failed' })
        .success
    ).toBe(false)
    expect(
      MediaEventSchema.safeParse({ type: 'handtracking.state', generation, state: 'started' })
        .success
    ).toBe(true)
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

  it('carries hand previews and the command that turns them on, and refuses a preview that is too big', () => {
    const generation = { sessionId: 'hand-1', revision: 1 }
    const preview = {
      type: 'hand.preview',
      preview: { generation, sequence: 4, width: 320, height: 180, jpeg: new Uint8Array([1, 2, 3]) }
    }
    expect(MediaEventSchema.safeParse(structuredClone(preview)).success).toBe(true)
    const bad = (patch: Record<string, unknown>) =>
      MediaEventSchema.safeParse({ ...preview, preview: { ...preview.preview, ...patch } }).success
    expect(bad({ jpeg: new Uint8Array(0) })).toBe(false)
    expect(bad({ jpeg: new Uint8Array(200_001) })).toBe(false)
    expect(bad({ jpeg: new Uint8Array(200_000) })).toBe(true)
    expect(bad({ jpeg: [1, 2, 3] })).toBe(false)
    expect(bad({ width: 641 })).toBe(false)
    expect(bad({ height: 0 })).toBe(false)
    expect(bad({ width: 320.5 })).toBe(false)
    expect(bad({ sequence: -1 })).toBe(false)
    expect(bad({ extra: 1 })).toBe(false)
    const command = {
      commandId: 'c1',
      command: { type: 'handtracking.preview', generation, enabled: true }
    }
    expect(MediaCommandEnvelopeSchema.safeParse(command).success).toBe(true)
    expect(
      MediaCommandEnvelopeSchema.safeParse({
        ...command,
        command: { ...command.command, enabled: 'yes' }
      }).success
    ).toBe(false)
    expect(
      MediaCommandEnvelopeSchema.safeParse({
        ...command,
        command: { type: 'handtracking.preview', generation }
      }).success
    ).toBe(false)
  })
})
