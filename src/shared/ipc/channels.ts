/** Internal fixed channels. They are not a generic renderer-facing send/invoke API. */
export const UI_CHANNELS = {
  command: 'jarvis:ui:command',
  snapshot: 'jarvis:ui:snapshot',
  event: 'jarvis:ui:event'
} as const

export const MEDIA_CHANNELS = {
  command: 'jarvis:media:command',
  event: 'jarvis:media:event'
} as const

export const AUTH_CHANNELS = {
  checkLoginId: 'jarvis:auth:check-login-id',
  signUp: 'jarvis:auth:sign-up',
  signIn: 'jarvis:auth:sign-in',
  restore: 'jarvis:auth:restore',
  signOut: 'jarvis:auth:sign-out',
  snapshot: 'jarvis:auth:snapshot',
  event: 'jarvis:auth:event'
} as const

export const CALENDAR_CHANNELS = {
  navigate: 'jarvis:calendar:navigate',
  create: 'jarvis:calendar:create',
  update: 'jarvis:calendar:update',
  delete: 'jarvis:calendar:delete',
  snapshot: 'jarvis:calendar:snapshot',
  event: 'jarvis:calendar:event'
} as const

export const GOOGLE_CHANNELS = {
  command: 'jarvis:google:command',
  snapshot: 'jarvis:google:snapshot',
  event: 'jarvis:google:event'
} as const

export const DEVICE_CHANNELS = {
  command: 'jarvis:devices:command',
  snapshot: 'jarvis:devices:snapshot',
  event: 'jarvis:devices:event'
} as const

export const COLLECTION_CHANNELS = {
  command: 'jarvis:collection:command',
  snapshot: 'jarvis:collection:snapshot',
  event: 'jarvis:collection:event'
} as const

export const GESTURE_DIAGNOSTICS_CHANNELS = {
  command: 'jarvis:gesture-diagnostics:command',
  snapshot: 'jarvis:gesture-diagnostics:snapshot',
  event: 'jarvis:gesture-diagnostics:event'
} as const

export const POPUP_CHANNELS = {
  state: 'jarvis:popup:state',
  snapshot: 'jarvis:popup:snapshot',
  respond: 'jarvis:popup:respond',
  resize: 'jarvis:popup:resize'
} as const

export const OVERLAY_CHANNELS = {
  state: 'jarvis:overlay:state',
  snapshot: 'jarvis:overlay:snapshot',
  interactive: 'jarvis:overlay:interactive',
  stop: 'jarvis:overlay:stop'
} as const
