import { z } from 'zod'
import { ClientErrorSchema, GenerationSchema, IdentifierSchema, SequenceSchema } from './common'

export const SensorKindSchema = z.enum(['camera', 'microphone'])
export type SensorKind = z.infer<typeof SensorKindSchema>
export const PermissionStateSchema = z.enum([
  'not_determined',
  'granted',
  'denied',
  'restricted',
  'unsupported'
])
export const SensorOwnerSchema = z.enum([
  'voice_wake',
  'speech_session',
  'gesture_call',
  'gesture_control',
  'diagnostics'
])

const SensorRequestFields = {
  kind: SensorKindSchema,
  owner: SensorOwnerSchema,
  generation: GenerationSchema
}

function matchesSensorOwner(value: {
  kind: SensorKind
  owner: z.infer<typeof SensorOwnerSchema>
}): boolean {
  if (value.owner === 'diagnostics') return true
  return value.owner === 'voice_wake' || value.owner === 'speech_session'
    ? value.kind === 'microphone'
    : value.kind === 'camera'
}

export const SensorAcquireRequestSchema = z
  .strictObject({ ...SensorRequestFields, deviceId: IdentifierSchema.optional() })
  .refine(matchesSensorOwner, 'Sensor kind must match its consuming feature')
export type SensorAcquireRequest = z.infer<typeof SensorAcquireRequestSchema>

export const SensorLeaseSchema = z
  .strictObject({
    ...SensorRequestFields,
    leaseId: IdentifierSchema,
    deviceId: IdentifierSchema
  })
  .refine(matchesSensorOwner, 'Sensor kind must match its consuming feature')
export type SensorLease = z.infer<typeof SensorLeaseSchema>

export const SensorDeviceSchema = z.strictObject({
  kind: SensorKindSchema,
  deviceId: IdentifierSchema,
  label: z.string().optional()
})
export type SensorDevice = z.infer<typeof SensorDeviceSchema>

export const SensorSnapshotSchema = z
  .strictObject({
    kind: SensorKindSchema,
    permission: PermissionStateSchema,
    state: z.enum(['idle', 'starting', 'active', 'stopping', 'unavailable', 'error']),
    deviceId: IdentifierSchema.optional(),
    leaseCount: SequenceSchema
  })
  .refine(
    (value) =>
      value.state !== 'active' ||
      (value.permission === 'granted' && value.leaseCount > 0 && value.deviceId !== undefined),
    'An active sensor needs permission, a device and at least one lease'
  )
export type SensorSnapshot = z.infer<typeof SensorSnapshotSchema>

export const SensorEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('sensor.state_changed'), snapshot: SensorSnapshotSchema }),
  z.strictObject({
    type: z.literal('sensor.devices_changed'),
    devices: z.array(SensorDeviceSchema)
  }),
  z.strictObject({
    type: z.literal('sensor.lease_revoked'),
    lease: SensorLeaseSchema,
    error: ClientErrorSchema
  })
])
export type SensorEvent = z.infer<typeof SensorEventSchema>

export const SensorReleaseResultSchema = z.strictObject({
  status: z.enum(['released', 'already_released'])
})
export type SensorReleaseResult = z.infer<typeof SensorReleaseResultSchema>
