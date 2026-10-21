import { z } from 'zod'
import { ClientErrorSchema, IdentifierSchema } from './common'

export const HttpUrlSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    error: 'URL must not have surrounding whitespace',
    abort: true
  })
  .pipe(z.string().url())
  .refine((value) => {
    try {
      return value === value.trim() && ['http:', 'https:'].includes(new URL(value).protocol)
    } catch {
      return false
    }
  }, 'Only absolute http/https URLs without surrounding whitespace are supported')

export const WindowReferenceSchema = z.strictObject({
  appId: IdentifierSchema,
  windowId: IdentifierSchema.optional()
})
export type WindowReference = z.infer<typeof WindowReferenceSchema>

export const AppDescriptorSchema = z.strictObject({
  appId: IdentifierSchema,
  displayName: z.string().min(1),
  state: z.enum(['running', 'stopped', 'unknown'])
})
export type AppDescriptor = z.infer<typeof AppDescriptorSchema>

export const AppObservationSchema = z.strictObject({
  kind: z.literal('app'),
  appId: IdentifierSchema,
  status: z.enum(['confirmed', 'dispatched', 'unknown']),
  windowId: IdentifierSchema.optional()
})
export type AppObservation = z.infer<typeof AppObservationSchema>

/** Browser handoff never proves that a page loaded successfully. */
export const UrlObservationSchema = z.strictObject({
  kind: z.literal('url'),
  url: HttpUrlSchema,
  status: z.enum(['dispatched', 'unknown'])
})
export type UrlObservation = z.infer<typeof UrlObservationSchema>

/** Folders are addressed by alias only; the path is resolved by Main and never leaves it. */
export const FOLDER_ALIASES = [
  'home',
  'desktop',
  'documents',
  'downloads',
  'pictures',
  'music',
  'videos'
] as const
export const FolderAliasSchema = z.enum(FOLDER_ALIASES)
export type FolderAlias = z.infer<typeof FolderAliasSchema>

/** Handing the folder to the file manager says nothing about a window having opened. */
export const FolderObservationSchema = z.strictObject({
  kind: z.literal('folder'),
  alias: FolderAliasSchema,
  status: z.enum(['dispatched', 'unknown'])
})
export type FolderObservation = z.infer<typeof FolderObservationSchema>

const VolumeLevelSchema = z.number().int().min(0).max(100)

/** A volume change is either an absolute level or a relative step, never a free-form value. */
export const VolumeChangeSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('set'), level: VolumeLevelSchema }),
  z.strictObject({ mode: z.literal('adjust'), delta: z.number().int().min(-100).max(100) })
])
export type VolumeChange = z.infer<typeof VolumeChangeSchema>

/**
 * The output volume and mute state read back from the OS after a change. A value is null when the
 * OS could not report it (for example an output device without a volume control).
 */
export const AudioObservationSchema = z.strictObject({
  kind: z.literal('audio'),
  level: VolumeLevelSchema.nullable(),
  muted: z.boolean().nullable(),
  status: z.enum(['confirmed', 'dispatched', 'unknown'])
})
export type AudioObservation = z.infer<typeof AudioObservationSchema>

export const TaskSwitchObservationSchema = z.strictObject({
  status: z.enum(['confirmed', 'dispatched', 'unknown'])
})
export type TaskSwitchObservation = z.infer<typeof TaskSwitchObservationSchema>

export const ToolNameSchema = z.enum([
  'apps.list',
  'apps.launch',
  'apps.activate',
  'apps.restore',
  'browser.open',
  'folder.open',
  'system.volume',
  'system.mute'
])
export type ToolName = z.infer<typeof ToolNameSchema>

export const ToolCommandSchema = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('apps.list'), arguments: z.strictObject({}) }),
  z.strictObject({
    tool: z.literal('apps.launch'),
    arguments: z.strictObject({ appId: IdentifierSchema })
  }),
  z.strictObject({
    tool: z.literal('apps.activate'),
    arguments: z.strictObject({ appId: IdentifierSchema })
  }),
  z.strictObject({ tool: z.literal('apps.restore'), arguments: z.strictObject({}) }),
  z.strictObject({
    tool: z.literal('browser.open'),
    arguments: z.strictObject({ url: HttpUrlSchema })
  }),
  z.strictObject({
    tool: z.literal('folder.open'),
    arguments: z.strictObject({ alias: FolderAliasSchema })
  }),
  z.strictObject({ tool: z.literal('system.volume'), arguments: VolumeChangeSchema }),
  z.strictObject({
    tool: z.literal('system.mute'),
    arguments: z.strictObject({ muted: z.boolean() })
  })
])
export type ToolCommand = z.infer<typeof ToolCommandSchema>

export const ToolInvocationSchema = z.strictObject({
  requestId: IdentifierSchema,
  executionId: IdentifierSchema,
  command: ToolCommandSchema
})
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>

export const CapabilitySchema = z.strictObject({
  tool: ToolNameSchema,
  version: z.number().int().positive(),
  availability: z.enum(['available', 'permission_required', 'unavailable', 'unsupported']),
  reason: z.string().optional()
})
export type Capability = z.infer<typeof CapabilitySchema>

const ToolObservationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('app_list'), apps: z.array(AppDescriptorSchema) }),
  AppObservationSchema,
  UrlObservationSchema,
  FolderObservationSchema,
  AudioObservationSchema
])
export const ToolOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('not_started'),
    reason: z.enum(['cancelled', 'expired', 'rejected']),
    error: ClientErrorSchema.optional()
  }),
  z.strictObject({ status: z.literal('observed'), observation: ToolObservationSchema }),
  z.strictObject({
    status: z.literal('failed'),
    error: ClientErrorSchema,
    effect: z.enum(['none', 'possible'])
  }),
  z.strictObject({ status: z.literal('unknown'), reason: z.string().min(1) })
])
export type ToolOutcome = z.infer<typeof ToolOutcomeSchema>

export const ToolExecutionReportSchema = z
  .strictObject({
    requestId: IdentifierSchema,
    executionId: IdentifierSchema,
    tool: ToolNameSchema,
    outcome: ToolOutcomeSchema,
    cancelRequested: z.boolean(),
    expired: z.boolean()
  })
  .refine((report) => {
    const outcome = report.outcome
    if (outcome.status === 'not_started') {
      return (
        (outcome.reason !== 'cancelled' || report.cancelRequested) &&
        (outcome.reason !== 'expired' || report.expired)
      )
    }
    if (outcome.status !== 'observed') return true
    const expected = {
      'apps.list': 'app_list',
      'browser.open': 'url',
      'folder.open': 'folder',
      'system.volume': 'audio',
      'system.mute': 'audio',
      'apps.launch': 'app',
      'apps.activate': 'app',
      'apps.restore': 'app'
    }[report.tool]
    return outcome.observation.kind === expected
  }, 'Execution evidence and cancellation must agree with the tool report')
export type ToolExecutionReport = z.infer<typeof ToolExecutionReportSchema>

export const CancelExecutionResultSchema = z.enum([
  'not_found',
  'prevented_start',
  'requested',
  'already_finished'
])
export type CancelExecutionResult = z.infer<typeof CancelExecutionResultSchema>
