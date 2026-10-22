import { z } from 'zod'

const HAS_ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i
const LOOKS_LIKE_TIME = /^\d{4}-\d{2}-\d{2}T/

/**
 * A time the server sends. Server times are UTC, but the real server leaves the zone off
 * (`2026-10-22T03:22:14.282428`), and `Date` would read such a string as local time, hours off.
 * A time without a zone is therefore read as UTC; one with a zone is taken as it is.
 */
export const ServerTimeSchema = z.preprocess(
  (value) =>
    typeof value === 'string' && LOOKS_LIKE_TIME.test(value) && !HAS_ZONE.test(value)
      ? `${value}Z`
      : value,
  z.iso.datetime({ offset: true })
)
