import {
  AuthEventSchema,
  AuthRequestContextSchema,
  CheckLoginIdRequestSchema,
  SignInRequestSchema,
  SignUpRequestSchema
} from '../shared/contracts/auth'
import {
  CalendarCreateEventRequestSchema,
  CalendarDeleteEventRequestSchema,
  CalendarEventSchema,
  CalendarNavigateRequestSchema,
  CalendarUpdateEventRequestSchema
} from '../shared/contracts/calendar'
import type { Result } from '../shared/contracts/common'
import {
  GoogleCommandRequestSchema,
  GoogleConnectionEventSchema
} from '../shared/contracts/google-connection'
import { UiCommandSchema, UiEventSchema } from '../shared/contracts/interaction'
import {
  AuthSnapshotResponseSchema,
  CheckLoginIdResponseSchema,
  SignInResponseSchema,
  SignOutResponseSchema,
  SignUpResponseSchema
} from '../shared/ipc/auth-api'
import type { AuthApi } from '../shared/ipc/auth-api'
import {
  CalendarEditResponseSchema,
  CalendarSnapshotResponseSchema
} from '../shared/ipc/calendar-api'
import type { CalendarApi } from '../shared/ipc/calendar-api'
import {
  AUTH_CHANNELS,
  CALENDAR_CHANNELS,
  GOOGLE_CHANNELS,
  UI_CHANNELS
} from '../shared/ipc/channels'
import { GoogleSnapshotResponseSchema } from '../shared/ipc/google-api'
import type { GoogleConnectionApi } from '../shared/ipc/google-api'
import { UiCommandResponseSchema, UiSnapshotResponseSchema } from '../shared/ipc/ui-api'
import type { UiApi } from '../shared/ipc/ui-api'

type EventListener = (event: unknown, value: unknown) => void
interface UiTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: EventListener): unknown
  removeListener(channel: string, listener: EventListener): unknown
}

export function createUiBridge(ipc: UiTransport, platform: string): UiApi {
  async function invoke<T>(
    channel: string,
    decode: (value: unknown) => Result<T>,
    ...args: unknown[]
  ): Promise<Result<T>> {
    try {
      return decode(await ipc.invoke(channel, ...args))
    } catch {
      return {
        ok: false,
        error: { code: 'unavailable', message: '앱과 연결하지 못했습니다. 다시 시도해 주세요.' }
      }
    }
  }
  const invalidInput = {
    ok: false,
    error: { code: 'invalid_input', message: '요청 형식이 올바르지 않습니다.' }
  } as const
  function authCall<Request, T>(
    channel: string,
    schema: { safeParse(value: unknown): { success: boolean; data?: Request } },
    decode: (value: unknown) => Result<T>,
    request: unknown
  ): Promise<Result<T>> {
    const parsed = schema.safeParse(request)
    if (!parsed.success) return Promise.resolve(invalidInput)
    return invoke(channel, decode, parsed.data)
  }
  const auth: AuthApi = {
    checkLoginId: (request) =>
      authCall(
        AUTH_CHANNELS.checkLoginId,
        CheckLoginIdRequestSchema,
        (value) => CheckLoginIdResponseSchema.parse(value),
        request
      ),
    signUp: (request) =>
      authCall(
        AUTH_CHANNELS.signUp,
        SignUpRequestSchema,
        (value) => SignUpResponseSchema.parse(value),
        request
      ),
    signIn: (request) =>
      authCall(
        AUTH_CHANNELS.signIn,
        SignInRequestSchema,
        (value) => SignInResponseSchema.parse(value),
        request
      ),
    restore: (request) =>
      authCall(
        AUTH_CHANNELS.restore,
        AuthRequestContextSchema,
        (value) => SignInResponseSchema.parse(value),
        request
      ),
    signOut: (request) =>
      authCall(
        AUTH_CHANNELS.signOut,
        AuthRequestContextSchema,
        (value) => SignOutResponseSchema.parse(value),
        request
      ),
    getSnapshot: () =>
      invoke(AUTH_CHANNELS.snapshot, (value) => AuthSnapshotResponseSchema.parse(value)),
    subscribe(listener) {
      let active = true
      const receive: EventListener = (_event, value) => {
        if (!active) return
        const parsed = AuthEventSchema.safeParse(value)
        if (parsed.success) listener(parsed.data)
      }
      ipc.on(AUTH_CHANNELS.event, receive)
      return () => {
        if (!active) return
        active = false
        ipc.removeListener(AUTH_CHANNELS.event, receive)
      }
    }
  }
  const calendar: CalendarApi = {
    navigate(request) {
      const parsed = CalendarNavigateRequestSchema.safeParse(request)
      if (!parsed.success) return Promise.resolve(invalidInput)
      return invoke(
        CALENDAR_CHANNELS.navigate,
        (value) => CalendarSnapshotResponseSchema.parse(value),
        parsed.data
      )
    },
    createEvent: (request) =>
      authCall(
        CALENDAR_CHANNELS.create,
        CalendarCreateEventRequestSchema,
        (value) => CalendarEditResponseSchema.parse(value),
        request
      ),
    updateEvent: (request) =>
      authCall(
        CALENDAR_CHANNELS.update,
        CalendarUpdateEventRequestSchema,
        (value) => CalendarEditResponseSchema.parse(value),
        request
      ),
    deleteEvent: (request) =>
      authCall(
        CALENDAR_CHANNELS.delete,
        CalendarDeleteEventRequestSchema,
        (value) => CalendarEditResponseSchema.parse(value),
        request
      ),
    getSnapshot: () =>
      invoke(CALENDAR_CHANNELS.snapshot, (value) => CalendarSnapshotResponseSchema.parse(value)),
    subscribe(listener) {
      let active = true
      const receive: EventListener = (_event, value) => {
        if (!active) return
        const parsed = CalendarEventSchema.safeParse(value)
        if (parsed.success) listener(parsed.data)
      }
      ipc.on(CALENDAR_CHANNELS.event, receive)
      return () => {
        if (!active) return
        active = false
        ipc.removeListener(CALENDAR_CHANNELS.event, receive)
      }
    }
  }
  const google: GoogleConnectionApi = {
    command: (request) =>
      authCall(
        GOOGLE_CHANNELS.command,
        GoogleCommandRequestSchema,
        (value) => GoogleSnapshotResponseSchema.parse(value),
        request
      ),
    getSnapshot: () =>
      invoke(GOOGLE_CHANNELS.snapshot, (value) => GoogleSnapshotResponseSchema.parse(value)),
    subscribe(listener) {
      let active = true
      const receive: EventListener = (_event, value) => {
        if (!active) return
        const parsed = GoogleConnectionEventSchema.safeParse(value)
        if (parsed.success) listener(parsed.data)
      }
      ipc.on(GOOGLE_CHANNELS.event, receive)
      return () => {
        if (!active) return
        active = false
        ipc.removeListener(GOOGLE_CHANNELS.event, receive)
      }
    }
  }
  return {
    platform,
    auth,
    calendar,
    google,
    dispatch(command) {
      const parsed = UiCommandSchema.safeParse(command)
      if (!parsed.success)
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid_input', message: '요청 형식이 올바르지 않습니다.' }
        })
      return invoke(
        UI_CHANNELS.command,
        (value) => UiCommandResponseSchema.parse(value),
        parsed.data
      )
    },
    getSnapshot: () =>
      invoke(UI_CHANNELS.snapshot, (value) => UiSnapshotResponseSchema.parse(value)),
    subscribe(listener) {
      let active = true
      const receive: EventListener = (_event, value) => {
        if (!active) return
        const parsed = UiEventSchema.safeParse(value)
        if (parsed.success) listener(parsed.data)
      }
      ipc.on(UI_CHANNELS.event, receive)
      return () => {
        if (!active) return
        active = false
        ipc.removeListener(UI_CHANNELS.event, receive)
      }
    }
  }
}
