import { z } from 'zod'
import { characterCount } from './auth'
import { ClientErrorSchema, SequenceSchema, TimestampSchema } from './common'

/**
 * The devices of the account and the apps of this device, as the settings tab shows them. Main
 * talks to the server; the window only draws this and asks for the few things below. Nothing the
 * server says word for word, no token and no device key is in it.
 */

/** What the server accepts as a device name (REST API spec, 2026-10-22): 1 to 100 characters once trimmed. */
export const DEVICE_NAME_RULE = { min: 1, max: 100 } as const

/** The name as it is sent: surrounding spaces are not kept. */
export const trimmedDeviceName = (value: string): string => value.trim()

export const isValidDeviceName = (value: string): boolean => {
  const length = characterCount(trimmedDeviceName(value))
  return length >= DEVICE_NAME_RULE.min && length <= DEVICE_NAME_RULE.max
}

/** The server's integer keys are strings inside the client. */
export const ServerEntityIdSchema = z.string().regex(/^\d{1,16}$/)

export const DEVICE_PLATFORMS = ['windows', 'macos', 'other'] as const
export const DevicePlatformSchema = z.enum(DEVICE_PLATFORMS)
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>

export const DeviceItemSchema = z.strictObject({
  id: ServerEntityIdSchema,
  name: z.string().min(1),
  platform: DevicePlatformSchema,
  clientVersion: z.string().min(1).nullable(),
  /** When the server last saw the device, on the server's clock; null if it never has. */
  lastSeenAt: TimestampSchema.nullable(),
  /** The device this window runs on. */
  current: z.boolean(),
  /** Seen within the last minute (a hint, not a promise). This device is always online. */
  online: z.boolean()
})
export type DeviceItem = z.infer<typeof DeviceItemSchema>

export const AppItemSchema = z.strictObject({
  id: ServerEntityIdSchema,
  /** One of the server's fixed app codes, or null for an app outside that set. */
  appCode: z.string().min(1).nullable(),
  name: z.string().min(1),
  allowed: z.boolean()
})
export type AppItem = z.infer<typeof AppItemSchema>

export const READ_STATES = ['idle', 'loading', 'ready', 'failed'] as const
export const ReadStateSchema = z.enum(READ_STATES)
export type ReadState = z.infer<typeof ReadStateSchema>

/** What is going on now; only one thing at a time. */
export const DEVICE_ACTIVITIES = [
  'none',
  'renaming',
  'signing_out_device',
  'signing_out_all',
  'setting_app'
] as const
export const DeviceActivitySchema = z.enum(DEVICE_ACTIVITIES)
export type DeviceActivity = z.infer<typeof DeviceActivitySchema>

/** What the last thing that finished came to, for a line of text. */
export const DEVICE_OUTCOMES = [
  'renamed',
  'device_signed_out',
  /** The device was no longer there; the list was read again. */
  'device_gone',
  'app_allowed',
  'app_blocked',
  'app_gone',
  /** The request may have been carried out, but the server did not say; the list was read again. */
  'unconfirmed',
  'failed'
] as const
export const DeviceOutcomeSchema = z.enum(DEVICE_OUTCOMES)
export type DeviceOutcome = z.infer<typeof DeviceOutcomeSchema>

/** Which panel an outcome belongs to: a device, an app, or the account as a whole. */
export const OUTCOME_SUBJECTS = ['device', 'app', 'account'] as const
export const OutcomeSubjectSchema = z.enum(OUTCOME_SUBJECTS)
export type OutcomeSubject = z.infer<typeof OutcomeSubjectSchema>

/**
 * `availability`: `unavailable` when there is no server to ask. `devices` and `apps` are the state
 * of reading each list. `target` is the device or app the activity is about, so a row can show it.
 */
export const DeviceManagementSnapshotSchema = z
  .strictObject({
    /** Rises with every change, so a late snapshot can be told from the current one. */
    revision: SequenceSchema,
    availability: z.enum(['ready', 'unavailable']),
    devices: z.strictObject({
      read: ReadStateSchema,
      items: z.array(DeviceItemSchema),
      error: ClientErrorSchema.nullable()
    }),
    apps: z.strictObject({
      read: ReadStateSchema,
      items: z.array(AppItemSchema),
      /** More apps exist than were read. */
      truncated: z.boolean(),
      error: ClientErrorSchema.nullable()
    }),
    activity: DeviceActivitySchema,
    target: ServerEntityIdSchema.nullable(),
    outcome: z
      .strictObject({
        kind: DeviceOutcomeSchema,
        subject: OutcomeSubjectSchema,
        at: TimestampSchema,
        /** Why it failed, for `failed` and `unconfirmed`. */
        error: ClientErrorSchema.nullable()
      })
      .nullable()
  })
  .refine((state) => withTarget(state.activity) === (state.target !== null), {
    message: 'A target goes with, and only with, an activity about one device or app'
  })
export type DeviceManagementSnapshot = z.infer<typeof DeviceManagementSnapshotSchema>

/** Signing out everywhere is about the account, not about one row. */
function withTarget(activity: DeviceActivity): boolean {
  return activity === 'renaming' || activity === 'signing_out_device' || activity === 'setting_app'
}

export const DEVICE_ACTIONS = [
  'refresh',
  'rename_device',
  'sign_out_device',
  'sign_out_all',
  'set_app_allowed'
] as const

export const DeviceCommandRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('refresh') }),
  z.strictObject({
    action: z.literal('rename_device'),
    deviceId: ServerEntityIdSchema,
    name: z.string().refine(isValidDeviceName, 'Device name must be 1 to 100 characters')
  }),
  z.strictObject({ action: z.literal('sign_out_device'), deviceId: ServerEntityIdSchema }),
  z.strictObject({ action: z.literal('sign_out_all') }),
  z.strictObject({
    action: z.literal('set_app_allowed'),
    appId: ServerEntityIdSchema,
    allowed: z.boolean()
  })
])
export type DeviceCommandRequest = z.infer<typeof DeviceCommandRequestSchema>

export const DeviceManagementEventSchema = z.strictObject({
  type: z.literal('devices.state_changed'),
  snapshot: DeviceManagementSnapshotSchema
})
export type DeviceManagementEvent = z.infer<typeof DeviceManagementEventSchema>
