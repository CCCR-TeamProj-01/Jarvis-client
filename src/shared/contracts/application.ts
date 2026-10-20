import { z } from 'zod'
import { ClientErrorSchema, IdentifierSchema } from './common'

export const ShortcutSnapshotSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('pending'), accelerator: IdentifierSchema }),
  z.strictObject({ status: z.literal('registered'), accelerator: IdentifierSchema }),
  z.strictObject({
    status: z.literal('unavailable'),
    accelerator: IdentifierSchema,
    error: ClientErrorSchema
  })
])
export type ShortcutSnapshot = z.infer<typeof ShortcutSnapshotSchema>

export const TraySnapshotSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('pending') }),
  z.strictObject({ status: z.literal('ready') }),
  z.strictObject({ status: z.literal('unavailable'), error: ClientErrorSchema })
])
export type TraySnapshot = z.infer<typeof TraySnapshotSchema>

/** Persistent startup state so registration failures are visible after the UI subscribes. */
export const ApplicationSnapshotSchema = z.strictObject({
  shortcut: ShortcutSnapshotSchema,
  tray: TraySnapshotSchema
})
export type ApplicationSnapshot = z.infer<typeof ApplicationSnapshotSchema>
