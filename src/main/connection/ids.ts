import { createHash, randomBytes } from 'node:crypto'

/** Crockford's base32, the alphabet of ULIDs (no I, L, O or U). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * A ULID-shaped 26-character identifier: 10 characters of time, so ids sort by creation, and 16
 * random ones. The server's examples (`req_01JAA80AXSZKMBRATXKHTZP3YV`) have this form.
 */
export function newUlid(
  nowMs: number = Date.now(),
  random: (size: number) => Uint8Array = randomBytes
): string {
  let time = Math.max(0, Math.floor(nowMs))
  let head = ''
  for (let index = 0; index < 10; index += 1) {
    head = ALPHABET[time % 32]! + head
    time = Math.floor(time / 32)
  }
  // 256 is a multiple of 32, so taking a byte modulo 32 is uniform.
  const tail = Array.from(random(16), (byte) => ALPHABET[byte % 32]!).join('')
  return `${head}${tail}`
}

/** A stable `Idempotency-Key` (8 to 128 safe characters) for something identified by a local ID. */
export function idempotencyKeyFor(purpose: string, id: string): string {
  return `${purpose}-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`
}
