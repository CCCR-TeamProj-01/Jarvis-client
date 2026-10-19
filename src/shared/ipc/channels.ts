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
