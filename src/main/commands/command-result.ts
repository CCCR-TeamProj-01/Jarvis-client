import { z } from 'zod'
import { APP_CODES } from '../platform/app-codes'

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
 * What the server is told about the app that was used, for the history and for recommendations.
 * Only an app that was launched or brought to the front is reported (never one that was closed),
 * and `running_apps` holds nothing but the server's fixed app codes: no window titles, paths,
 * addresses or process names. A missing `running_apps` means the list could not be taken or was
 * not allowed; an empty one means nothing from the fixed set was running.
 */
export const ActivityReportSchema = z.strictObject({
  event_key: z.string().min(1).max(160),
  event_type: z.enum(['launched', 'activated']),
  occurred_at: TimestampSchema,
  collection_revision: z.number().int().nonnegative(),
  running_apps: z
    .array(z.enum(APP_CODES))
    .max(100)
    .refine((codes) => new Set(codes).size === codes.length, 'App codes must not repeat')
    .optional()
})
export type ActivityReport = z.infer<typeof ActivityReportSchema>

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
      .optional(),
    activity: ActivityReportSchema.optional()
  })
  .refine(
    // The server refuses an activity without the app it is about, and records one only for a success.
    (body) => body.activity === undefined || (body.app !== undefined && body.status === 'success'),
    'An activity needs an app and a successful result'
  )
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
