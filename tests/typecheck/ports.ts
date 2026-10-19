/** Compile-time examples: clients can supply these ports without Electron, devices or a server. */
import type { PointerInputPort } from '../../src/main/platform/ports'
import type { SensorPort } from '../../src/main/sensors/ports'
import type { AudioPlaybackPort } from '../../src/renderer/media/audio-playback/ports'

const unavailable = {
  ok: false,
  error: { code: 'unavailable', message: 'Example backend is unavailable' }
} as const

export const sensorStub = {
  listDevices: async () => unavailable,
  acquire: async () => unavailable,
  release: async () => unavailable,
  getSnapshot: (kind) => ({ kind, permission: 'not_determined', state: 'idle', leaseCount: 0 }),
  subscribe: () => () => undefined
} satisfies SensorPort

export const pointerStub = {
  getDisplays: async () => unavailable,
  moveTo: async () => unavailable,
  click: async () => unavailable,
  releaseOwnedInputs: async () => ({ ok: true, value: undefined }),
  cancelGeneration: async () => ({ ok: true, value: undefined })
} satisfies PointerInputPort

export const playbackStub = {
  play: async () => unavailable,
  stop: async () => unavailable,
  subscribe: () => () => undefined
} satisfies AudioPlaybackPort
