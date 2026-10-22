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

const TimestampSchema = z.iso.datetime({ offset: true })

/**
 * The body of `POST /commands/{command_id}/results` (the command ID is in the path). It mirrors the
 * server's own checks so a body the server would refuse is never sent. The three times are fixed
 * when the result is made, because the server compares them when the same result is sent again.
 */
export const CommandResultSchema = z
  .strictObject({
    attempt_no: z.number().int().positive(),
    status: z.enum(['success', 'failed', 'rejected', 'unknown']),
    observation_status: z.enum(['confirmed', 'dispatched', 'unknown', 'not_applicable']),
    error_code: ResultErrorCodeSchema.optional(),
    failure_stage: FailureStageSchema.optional(),
    result_message: z.string().min(1).max(200).optional(),
    started_at: TimestampSchema,
    finished_at: TimestampSchema,
    reported_at: TimestampSchema,
    app: z
      .strictObject({
        app_code: z.string().min(1),
        os_app_id: z.string().min(1),
        display_name: z.string().min(1)
      })
      .optional()
  })
  .refine(
    // A stage describes a failure; the server refuses it on a success or an unknown result.
    (body) => body.failure_stage === undefined || ['failed', 'rejected'].includes(body.status),
    'failure_stage is only valid for failed or rejected results'
  )
  .refine(
    (body) => Date.parse(body.finished_at) >= Date.parse(body.started_at),
    'finished_at must not precede started_at'
  )
export type CommandResult = z.infer<typeof CommandResultSchema>

/** When a command started and finished, in local wall-clock milliseconds. */
export interface CommandTiming {
  startedAtMs: number
  finishedAtMs: number
}

/** A command that was refused before anything ran. */
export interface CommandRejection {
  failureStage: 'validation' | 'capability'
  errorCode: 'invalid_input' | 'unsupported'
  message: string
}
