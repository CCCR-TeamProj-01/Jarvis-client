import { z } from 'zod'
import { AuthSnapshotSchema } from './auth'
import { ApplicationSnapshotSchema } from './application'
import {
  ClientErrorSchema,
  GenerationSchema,
  IdentifierSchema,
  SequenceSchema,
  TimestampSchema
} from './common'
import { GestureSnapshotSchema } from './gesture'
import { SensorSnapshotSchema } from './sensors'
import { SpeechSnapshotSchema } from './speech'
import { WakeWordSnapshotSchema } from './wake-word'

/**
 * What the main window shows. Signed-out clients see `login` or `signup`; a signed-in one sees one of
 * the three tabs, and `input`, `result` and `confirmation` are kept for the temporary windows.
 */
export const ScreenSchema = z.enum([
  'login',
  'signup',
  'conversation',
  'gesture',
  'settings',
  'input',
  'result',
  'confirmation'
])
export type Screen = z.infer<typeof ScreenSchema>

/** The tabs of the signed-in window. */
export const TabSchema = z.enum(['conversation', 'gesture', 'settings'])
export type Tab = z.infer<typeof TabSchema>

export const UiCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('app.quit') }),
  z.strictObject({ type: z.literal('auth.open'), screen: z.enum(['login', 'signup']) }),
  z.strictObject({ type: z.literal('screen.open'), screen: TabSchema }),
  z.strictObject({ type: z.literal('conversation.start') }),
  z.strictObject({
    type: z.literal('conversation.submit_text'),
    text: z.string().refine((value) => value.trim().length > 0, 'Text must not be blank')
  }),
  z.strictObject({ type: z.literal('conversation.stop') }),
  z.strictObject({ type: z.literal('gesture.start') }),
  z.strictObject({ type: z.literal('gesture.stop') }),
  z.strictObject({ type: z.literal('recognition.pause') }),
  z.strictObject({ type: z.literal('recognition.resume') }),
  z.strictObject({ type: z.literal('settings.open') }),
  z.strictObject({ type: z.literal('wake_word.set_enabled'), enabled: z.boolean() }),
  z.strictObject({
    type: z.literal('confirmation.respond'),
    confirmationId: IdentifierSchema,
    decision: z.enum(['approve', 'reject', 'dismiss'])
  })
])
export type UiCommand = z.infer<typeof UiCommandSchema>

export const CommandReceiptSchema = z.strictObject({
  commandId: IdentifierSchema,
  status: z.literal('accepted')
})
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>

export const ClientSnapshotSchema = z
  .strictObject({
    revision: SequenceSchema,
    application: ApplicationSnapshotSchema,
    auth: AuthSnapshotSchema,
    recognitionPaused: z.boolean(),
    conversation: z
      .strictObject({
        phase: z.enum(['idle', 'active']),
        generation: GenerationSchema.nullable()
      })
      .refine(
        (conversation) => (conversation.phase === 'idle') === (conversation.generation === null),
        'An active conversation requires its generation'
      ),
    request: z
      .strictObject({
        requestId: IdentifierSchema.nullable(),
        phase: z.enum(['idle', 'processing', 'awaiting_confirmation', 'executing', 'terminal'])
      })
      .refine(
        (request) => (request.phase === 'idle') === (request.requestId === null),
        'A non-idle request requires its identifier'
      ),
    speech: SpeechSnapshotSchema,
    wakeWord: WakeWordSnapshotSchema.optional(),
    gesture: GestureSnapshotSchema,
    sensors: z.array(SensorSnapshotSchema).max(2),
    screen: ScreenSchema,
    connection: z.enum(['offline', 'connecting', 'online'])
  })
  .refine(
    (state) => new Set(state.sensors.map((sensor) => sensor.kind)).size === state.sensors.length,
    'Sensor kinds must be unique in a snapshot'
  )
  .refine(
    (state) =>
      state.auth.phase === 'signed_in' || state.screen === 'login' || state.screen === 'signup',
    'Unauthenticated clients must show an authentication screen'
  )
export type ClientSnapshot = z.infer<typeof ClientSnapshotSchema>

export const ConfirmationRequestSchema = z.strictObject({
  confirmationId: IdentifierSchema,
  target: z.string().min(1),
  action: z.string().min(1),
  /** Display only. Main independently enforces its local monotonic deadline. */
  expiresAtUnixMs: TimestampSchema
})
export type ConfirmationRequest = z.infer<typeof ConfirmationRequestSchema>

export const UiEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('state.changed'), snapshot: ClientSnapshotSchema }),
  z.strictObject({
    type: z.literal('result.available'),
    requestId: IdentifierSchema,
    /** Who the line is from: the user's words, the assistant's answer, or a tool's result. */
    role: z.enum(['user', 'assistant', 'tool']),
    text: z.string()
  }),
  z.strictObject({
    type: z.literal('confirmation.requested'),
    confirmation: ConfirmationRequestSchema
  }),
  z.strictObject({ type: z.literal('client.error'), error: ClientErrorSchema })
])
export type UiEvent = z.infer<typeof UiEventSchema>
