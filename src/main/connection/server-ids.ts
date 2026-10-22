import { z } from 'zod'

/**
 * The server's integer primary keys arrive as JSON numbers. A number beyond 2^53-1 has already
 * lost precision when it was parsed, so only a safe integer is accepted. Inside the client an ID
 * is a string, like every other identifier.
 */
export const ServerIdSchema = z
  .number()
  .refine(
    (value) => Number.isSafeInteger(value) && value >= 0,
    'Expected a safe non-negative integer'
  )
  .transform((value) => String(value))
