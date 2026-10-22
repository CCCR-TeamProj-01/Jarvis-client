import { z } from 'zod'
import type { SessionCredential } from './ports'

/**
 * What survives a restart: the token pair, when each expires, the installation it was issued to and
 * who the session belongs to (a renewal answers with tokens only, so the user is kept from login). It lives inside the opaque `SessionCredential`, so the protected store is unchanged and no
 * other layer ever sees a token. Expiry times are local wall-clock milliseconds, computed from the
 * server's relative lifetimes when they arrived, so a wrong server clock cannot skew them.
 */
const StoredSessionSchema = z.strictObject({
  v: z.literal(1),
  sessionId: z.string().min(1),
  deviceKey: z.uuid(),
  userId: z.string().min(1),
  loginId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessExpiresAtUnixMs: z.number().int().positive(),
  refreshExpiresAtUnixMs: z.number().int().positive()
})
export type StoredSession = z.infer<typeof StoredSessionSchema>

export function encodeSession(session: StoredSession): SessionCredential {
  return { opaque: JSON.stringify(StoredSessionSchema.parse(session)) }
}

/** Null for anything that is not a session written by this adapter (damaged or from another one). */
export function decodeSession(credential: SessionCredential): StoredSession | null {
  try {
    const parsed = StoredSessionSchema.safeParse(JSON.parse(credential.opaque))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The access token the server client attaches. Held in memory only. */
export class AccessTokenHolder {
  private token: string | null = null

  get(): string | null {
    return this.token
  }

  set(token: string): void {
    this.token = token
  }

  clear(): void {
    this.token = null
  }
}
