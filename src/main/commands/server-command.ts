import { z } from 'zod'
import { ServerIdSchema } from '../connection/server-ids'

const HAS_ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i
const LOOKS_LIKE_TIME = /^\d{4}-\d{2}-\d{2}T/

/**
 * A time the server sends. Server times are UTC, but the real server leaves the zone off
 * (`2026-10-22T03:22:14.282428`), and `Date` would read such a string as local time, hours off.
 * A time without a zone is therefore read as UTC; one with a zone is taken as it is.
 */
export const ServerTimeSchema = z.preprocess(
  (value) =>
    typeof value === 'string' && LOOKS_LIKE_TIME.test(value) && !HAS_ZONE.test(value)
      ? `${value}Z`
      : value,
  z.iso.datetime({ offset: true })
)

/**
 * One command as the server hands it to this device. Unknown extra fields are ignored so a server
 * that adds a field does not stop every command; the arguments themselves are checked per tool.
 */
export const ServerCommandSchema = z.looseObject({
  command_id: ServerIdSchema,
  attempt_no: z.number().int().positive(),
  command_type: z.string().min(1),
  requested_app_code: z.string().nullish(),
  arguments: z.record(z.string(), z.unknown()),
  requested_at: ServerTimeSchema
})
export type ServerCommand = z.infer<typeof ServerCommandSchema>

/** The local execution ID is stable for one `(command_id, attempt_no)` across resends. */
export function executionIdFor(command: Pick<ServerCommand, 'command_id' | 'attempt_no'>): string {
  return `cmd-${command.command_id}-${command.attempt_no}`
}
