import { describe, expect, it } from 'vitest'
import { ClientErrorSchema } from '../../src/shared/contracts/common'
import { classifyServerError } from '../../src/main/connection/server-errors'
import { ServerIdSchema } from '../../src/main/connection/server-ids'
import { ServerClock } from '../../src/main/connection/server-clock'

describe('server error mapping', () => {
  it.each([
    [401, 'INVALID_CREDENTIALS', 'invalid_credentials'],
    [409, 'USERNAME_TAKEN', 'login_id_taken'],
    [401, 'INVALID_SESSION', 'session_expired'],
    [401, 'REFRESH_TOKEN_REUSED', 'session_expired'],
    [429, 'RATE_LIMITED', 'rate_limited'],
    [422, 'VALIDATION_ERROR', 'invalid_input'],
    [404, 'DEVICE_NOT_FOUND', 'not_found'],
    [404, 'COMMAND_NOT_FOUND', 'not_found'],
    [409, 'CONVERSATION_BUSY', 'conflict'],
    [409, 'REQUEST_ID_CONFLICT', 'conflict'],
    [409, 'COMMAND_RESULT_CONFLICT', 'conflict'],
    [410, 'RECOMMENDATION_EXPIRED', 'expired'],
    [403, 'COMMAND_DEVICE_MISMATCH', 'permission_denied'],
    [403, 'ACTIVITY_COLLECTION_DISABLED', 'permission_denied'],
    [503, 'SERVICE_UNAVAILABLE', 'unavailable'],
    [502, 'UPSTREAM_ERROR', 'unavailable'],
    [500, 'INTERNAL_ERROR', 'unavailable']
  ])('maps %i %s to %s', (status, serverCode, code) => {
    expect(classifyServerError(status, serverCode).code).toBe(code)
  })

  it('falls back to the HTTP status for a code it does not know', () => {
    expect(classifyServerError(401, 'SOMETHING_NEW').code).toBe('session_expired')
    expect(classifyServerError(403, undefined).code).toBe('permission_denied')
    expect(classifyServerError(404, undefined).code).toBe('not_found')
    expect(classifyServerError(409, 'X').code).toBe('conflict')
    expect(classifyServerError(422, undefined).code).toBe('invalid_input')
    expect(classifyServerError(429, undefined).code).toBe('rate_limited')
    expect(classifyServerError(502, undefined).code).toBe('unavailable')
    expect(classifyServerError(418, undefined).code).toBe('internal')
  })

  it('always yields a valid client error with fixed wording', () => {
    for (const status of [400, 401, 403, 404, 409, 410, 422, 429, 500, 503])
      expect(ClientErrorSchema.safeParse(classifyServerError(status, undefined)).success).toBe(true)
    expect(classifyServerError(401, 'INVALID_CREDENTIALS').message).toBe(
      '아이디 또는 비밀번호가 올바르지 않습니다.'
    )
  })
})

describe('server ids', () => {
  it('turns safe integers into strings', () => {
    expect(ServerIdSchema.parse(0)).toBe('0')
    expect(ServerIdSchema.parse(8801)).toBe('8801')
    expect(ServerIdSchema.parse(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991')
  })

  it('rejects anything that is not a safe non-negative integer', () => {
    for (const bad of [-1, 1.5, 2 ** 53, Number.NaN, Infinity, '12', null, undefined, {}])
      expect(ServerIdSchema.safeParse(bad).success).toBe(false)
    // A BIGINT past 2^53 loses precision when JSON is parsed, so it never looks like a valid ID.
    expect(ServerIdSchema.safeParse(JSON.parse('9007199254740993')).success).toBe(false)
  })
})

describe('server clock', () => {
  it('learns the offset from a Date header and applies it', () => {
    const clock = new ServerClock()
    expect(clock.offsetMs).toBeNull()
    expect(clock.serverTimeAt(1_000)).toBeNull()
    clock.observe('Thu, 22 Oct 2026 00:00:10 GMT', Date.parse('2026-10-22T00:00:00Z'))
    expect(clock.offsetMs).toBe(10_000)
    expect(clock.serverTimeAt(5_000)).toBe(15_000)
  })

  it('ignores a missing or unreadable header', () => {
    const clock = new ServerClock()
    clock.observe('Thu, 22 Oct 2026 00:00:10 GMT', Date.parse('2026-10-22T00:00:00Z'))
    clock.observe(null, 0)
    clock.observe('not a date', 0)
    expect(clock.offsetMs).toBe(10_000)
  })
})
