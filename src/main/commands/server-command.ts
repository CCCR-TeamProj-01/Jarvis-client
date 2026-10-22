import { z } from 'zod'
import { ServerIdSchema } from '../connection/server-ids'
import { ServerTimeSchema } from '../connection/server-time'

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
