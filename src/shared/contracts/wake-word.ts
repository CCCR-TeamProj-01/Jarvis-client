import { z } from 'zod'
import { ClientErrorSchema } from './common'

/** Session-only opt-in. Account changes and restarting the app turn it off. */
export const WakeWordSnapshotSchema = z.strictObject({
  enabled: z.boolean(),
  phase: z.enum(['off', 'starting', 'listening', 'suspended', 'error']),
  error: ClientErrorSchema.optional()
})
export type WakeWordSnapshot = z.infer<typeof WakeWordSnapshotSchema>
