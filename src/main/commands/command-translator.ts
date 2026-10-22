import type { ToolCommand, ToolInvocation } from '../../shared/contracts/tools'
import { ToolCommandSchema } from '../../shared/contracts/tools'
import { isAppCode, osAppIdFor } from '../platform/app-codes'
import type { AppCode } from '../platform/app-codes'
import type { CommandRejection } from './command-result'
import { executionIdFor } from './server-command'
import type { ServerCommand } from './server-command'

export interface TranslatedCommand {
  command: ToolCommand
  /** The app the command is about, so the result can tell the server which local app it was. */
  app?: { appCode: AppCode; osAppId: string }
}

export type Translation =
  | { ok: true; value: TranslatedCommand }
  | { ok: false; rejection: CommandRejection }

const INVALID: CommandRejection = {
  failureStage: 'validation',
  errorCode: 'invalid_input',
  message: '명령의 인자가 올바르지 않아 실행하지 않았어요.'
}

const UNSUPPORTED: CommandRejection = {
  failureStage: 'capability',
  errorCode: 'unsupported',
  message: '이 기기에서는 지원하지 않는 명령이에요.'
}

/** A Map, so a type such as `__proto__` or `constructor` is just an unknown name. */
const APP_COMMANDS: ReadonlyMap<string, 'apps.launch' | 'apps.activate'> = new Map([
  ['apps.launch', 'apps.launch'],
  ['apps.activate', 'apps.activate']
])

/**
 * Turns a server command into a local tool command. Everything that comes from the server is
 * checked again by the tool contract; a command that cannot be translated is refused, never
 * partly run.
 */
export function translateCommand(command: ServerCommand, platform: NodeJS.Platform): Translation {
  const type = command.command_type
  const appTool = APP_COMMANDS.get(type)
  if (appTool) return translateAppCommand(appTool, command, platform)

  const candidate = build(type, command.arguments)
  if (!candidate) return { ok: false, rejection: UNSUPPORTED }
  const parsed = ToolCommandSchema.safeParse(candidate)
  return parsed.success
    ? { ok: true, value: { command: parsed.data } }
    : { ok: false, rejection: INVALID }
}

function translateAppCommand(
  tool: 'apps.launch' | 'apps.activate',
  command: ServerCommand,
  platform: NodeJS.Platform
): Translation {
  // The application is named by the top-level code, so `arguments` must be empty.
  if (Object.keys(command.arguments).length > 0) return { ok: false, rejection: INVALID }
  const code = command.requested_app_code
  if (!code || !isAppCode(code)) return { ok: false, rejection: INVALID }
  const osAppId = osAppIdFor(code, platform)
  if (!osAppId) return { ok: false, rejection: UNSUPPORTED }
  const parsed = ToolCommandSchema.safeParse({ tool, arguments: { appId: osAppId } })
  if (!parsed.success) return { ok: false, rejection: INVALID }
  return { ok: true, value: { command: parsed.data, app: { appCode: code, osAppId } } }
}

/**
 * The tool command in the local shape, or undefined when this client does not run the type. That
 * covers types the server can send but no tool here handles yet (`apps.close`, `browser.search`)
 * and `apps.list` / `system.status`, which ask for values the server has not said how to receive.
 */
function build(type: string, args: Record<string, unknown>): unknown {
  switch (type) {
    case 'apps.restore':
      return { tool: 'apps.restore', arguments: args }
    case 'browser.open':
      return { tool: 'browser.open', arguments: args }
    case 'folder.open':
      return { tool: 'folder.open', arguments: args }
    case 'system.volume':
      return { tool: 'system.volume', arguments: args }
    case 'system.mute':
      return { tool: 'system.mute', arguments: args }
    default:
      return undefined
  }
}

/** The invocation handed to the tool executor; its execution ID is stable across resends. */
export function invocationFor(
  command: ServerCommand,
  tool: ToolCommand,
  requestId = `cmd-${command.command_id}`
): ToolInvocation {
  return { requestId, executionId: executionIdFor(command), command: tool }
}
