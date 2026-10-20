import type { IpcMain, WebContents } from 'electron'
import type { z } from 'zod'
import {
  AuthEventSchema,
  AuthRequestContextSchema,
  CheckLoginIdRequestSchema,
  SignInRequestSchema,
  SignUpRequestSchema
} from '../../shared/contracts/auth'
import { AUTH_CHANNELS } from '../../shared/ipc/channels'
import {
  AuthSnapshotResponseSchema,
  CheckLoginIdResponseSchema,
  SignInResponseSchema,
  SignOutResponseSchema,
  SignUpResponseSchema
} from '../../shared/ipc/auth-api'
import type { AuthPort } from '../auth/auth-manager'
import { isTrustedUiSender } from './ui-ipc'

interface AuthIpcOptions {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  getContents(): WebContents | null
  entryUrl: string
  auth: AuthPort
}

const denied = {
  ok: false,
  error: { code: 'permission_denied', message: '허용되지 않은 화면의 요청입니다.' }
} as const
const invalid = {
  ok: false,
  error: { code: 'invalid_input', message: '요청 형식이 올바르지 않습니다.' }
} as const
const failed = {
  ok: false,
  error: { code: 'internal', message: '요청을 처리하지 못했습니다.' }
} as const

/**
 * Sender, argument count, request shape and response shape are all checked here. Passwords reach
 * the gateway through this path only and are never logged or placed in a snapshot.
 */
export function registerAuthIpc({ ipc, getContents, entryUrl, auth }: AuthIpcOptions): () => void {
  const channels: string[] = []

  function handle<Request, Response>(
    channel: string,
    requestSchema: z.ZodType<Request> | null,
    responseSchema: z.ZodType<Response>,
    run: (request: Request) => Promise<unknown> | unknown
  ): void {
    channels.push(channel)
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedUiSender(event, getContents(), entryUrl)) return denied
      let request: Request | undefined
      if (requestSchema) {
        if (args.length !== 1) return invalid
        const parsed = requestSchema.safeParse(args[0])
        if (!parsed.success) return invalid
        request = parsed.data
      } else if (args.length !== 0) return invalid
      try {
        const response = responseSchema.safeParse(await run(request as Request))
        return response.success ? response.data : failed
      } catch {
        return failed
      }
    })
  }

  handle(AUTH_CHANNELS.checkLoginId, CheckLoginIdRequestSchema, CheckLoginIdResponseSchema, (r) =>
    auth.checkLoginId(r)
  )
  handle(AUTH_CHANNELS.signUp, SignUpRequestSchema, SignUpResponseSchema, (r) => auth.signUp(r))
  handle(AUTH_CHANNELS.signIn, SignInRequestSchema, SignInResponseSchema, (r) => auth.signIn(r))
  handle(AUTH_CHANNELS.restore, AuthRequestContextSchema, SignInResponseSchema, (r) =>
    auth.restore(r)
  )
  handle(AUTH_CHANNELS.signOut, AuthRequestContextSchema, SignOutResponseSchema, (r) =>
    auth.signOut(r)
  )
  handle(AUTH_CHANNELS.snapshot, null, AuthSnapshotResponseSchema, () => ({
    ok: true,
    value: auth.getSnapshot()
  }))

  const unsubscribe = auth.subscribe((event) => {
    const parsed = AuthEventSchema.safeParse(event)
    if (!parsed.success) return
    const contents = getContents()
    if (!contents || contents.isDestroyed()) return
    try {
      if (contents.mainFrame.url === entryUrl) contents.send(AUTH_CHANNELS.event, parsed.data)
    } catch {
      /* The frame may disappear while its window closes or reloads. */
    }
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    for (const channel of channels) ipc.removeHandler(channel)
  }
}
