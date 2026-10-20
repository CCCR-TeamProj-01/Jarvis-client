import { describe, expect, it } from 'vitest'
import { UiCommandSchema, ClientSnapshotSchema } from '../../src/shared/contracts/interaction'
import {
  SensorAcquireRequestSchema,
  SensorSnapshotSchema
} from '../../src/shared/contracts/sensors'
import { clientSnapshot, generation } from '../fixtures/contracts'

describe('UI command boundary', () => {
  it('keeps conversation activation separate from gesture control', () => {
    expect(UiCommandSchema.parse({ type: 'conversation.start' }).type).toBe('conversation.start')
    expect(UiCommandSchema.parse({ type: 'gesture.start' }).type).toBe('gesture.start')
    expect(
      UiCommandSchema.safeParse({ type: 'conversation.start', startGesture: true }).success
    ).toBe(false)
  })

  it.each([
    { type: 'conversation.start', source: 'voice' },
    { type: 'conversation.submit_text', text: '  ' },
    { type: 'camera.start', leaseId: 'lease-1' },
    { type: 'confirmation.respond', confirmationId: 'c-1', decision: 'closed' },
    { type: 'arbitrary.shell', command: 'open anything' }
  ])('rejects invalid or privileged UI input: %j', (command) => {
    expect(UiCommandSchema.safeParse(command).success).toBe(false)
  })

  it('preserves closing as dismissal rather than approval', () => {
    expect(
      UiCommandSchema.parse({
        type: 'confirmation.respond',
        confirmationId: 'c-1',
        decision: 'dismiss'
      })
    ).toMatchObject({ decision: 'dismiss' })
  })

  it('rejects duplicate sensor states in a snapshot', () => {
    const camera = { kind: 'camera', permission: 'not_determined', state: 'idle', leaseCount: 0 }
    const snapshot = clientSnapshot()
    const singleSensor = { ...snapshot, sensors: [camera] }
    expect(ClientSnapshotSchema.safeParse(singleSensor).success).toBe(true)
    expect(
      ClientSnapshotSchema.safeParse({ ...singleSensor, sensors: [camera, camera] }).success
    ).toBe(false)
  })
})

describe('sensor lease boundary', () => {
  it.each([
    ['voice_wake', 'microphone', true],
    ['speech_session', 'microphone', true],
    ['gesture_call', 'camera', true],
    ['gesture_control', 'camera', true],
    ['diagnostics', 'camera', true],
    ['diagnostics', 'microphone', true],
    ['voice_wake', 'camera', false],
    ['gesture_control', 'microphone', false]
  ])('validates %s consuming %s', (owner, kind, valid) => {
    expect(SensorAcquireRequestSchema.safeParse({ owner, kind, generation }).success).toBe(valid)
  })

  it('requires permission and a lease before reporting an active sensor', () => {
    const state = {
      kind: 'camera',
      permission: 'granted',
      state: 'active',
      deviceId: 'cam',
      leaseCount: 1
    }
    expect(SensorSnapshotSchema.safeParse(state).success).toBe(true)
    expect(SensorSnapshotSchema.safeParse({ ...state, permission: 'denied' }).success).toBe(false)
    expect(SensorSnapshotSchema.safeParse({ ...state, leaseCount: 0 }).success).toBe(false)
    expect(
      SensorSnapshotSchema.safeParse({ ...state, state: 'stopping', leaseCount: 0 }).success
    ).toBe(true)
  })
})
