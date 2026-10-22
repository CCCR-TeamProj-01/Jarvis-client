import { z } from 'zod'

export const FAILURE_STAGES = [
  'validation',
  'capability',
  'precondition',
  'dispatch',
  'execution',
  'observation',
  'timeout',
  'cancellation',
  'internal'
] as const
export const FailureStageSchema = z.enum(FAILURE_STAGES)

/** Codes the client sends; lower snake_case so they are never mistaken for the server's own. */
export const RESULT_ERROR_CODES = [
  'permission_denied',
  'unsupported',
  'invalid_input',
  'not_found',
  'cancelled',
  'expired',
  'unavailable',
  'internal',
  'unknown'
] as const
export const ResultErrorCodeSchema = z.enum(RESULT_ERROR_CODES)

/** The body of `POST /commands/{command_id}/results`. The command ID is in the path. */
export const CommandResultSchema = z.strictObject({
  attempt_no: z.number().int().positive(),
  status: z.enum(['success', 'failed', 'rejected', 'unknown']),
  observation_status: z.enum(['confirmed', 'dispatched', 'unknown', 'not_applicable']),
  error_code: ResultErrorCodeSchema.optional(),
  failure_stage: FailureStageSchema.optional(),
  result_message: z.string().min(1).max(200).optional(),
  app: z
    .strictObject({
      app_code: z.string().min(1),
      os_app_id: z.string().min(1),
      display_name: z.string().min(1)
    })
    .optional()
})
export type CommandResult = z.infer<typeof CommandResultSchema>

/** A command that was refused before anything ran. */
export interface CommandRejection {
  failureStage: 'validation' | 'capability'
  errorCode: 'invalid_input' | 'unsupported'
  message: string
}
