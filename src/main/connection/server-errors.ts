import type { ClientError } from '../../shared/contracts/common'

type Code = ClientError['code']

/** Fixed wording per code. The server's own `message` is never shown to the user. */
const MESSAGES: Record<Code, string> = {
  permission_denied: '이 작업을 할 권한이 없습니다.',
  authentication_required: '로그인이 필요합니다.',
  invalid_credentials: '아이디 또는 비밀번호가 올바르지 않습니다.',
  login_id_taken: '이미 사용 중인 아이디입니다.',
  session_expired: '로그인 정보가 만료되었습니다. 다시 로그인해 주세요.',
  rate_limited: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  credential_unavailable: '이 기기에서는 로그인 정보를 안전하게 보관할 수 없습니다.',
  device_unavailable: '이 기기를 사용할 수 없습니다.',
  unsupported: '이 서버에서 지원하지 않는 기능입니다.',
  invalid_input: '입력한 내용이 올바르지 않습니다.',
  not_found: '요청한 항목을 찾을 수 없습니다.',
  cancelled: '요청이 취소되었습니다.',
  expired: '요청 시간이 지났습니다.',
  conflict: '요청이 현재 상태와 맞지 않습니다. 잠시 후 다시 시도해 주세요.',
  unavailable: '서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  internal: '서버 응답을 처리하지 못했습니다.'
}

export const clientError = (code: Code): ClientError => ({ code, message: MESSAGES[code] })

/** The server's error codes (REST API spec) in client terms. */
const BY_SERVER_CODE: Readonly<Record<string, Code>> = {
  INVALID_CREDENTIALS: 'invalid_credentials',
  USERNAME_TAKEN: 'login_id_taken',
  INVALID_SESSION: 'session_expired',
  REFRESH_TOKEN_REUSED: 'session_expired',
  RATE_LIMITED: 'rate_limited',
  VALIDATION_ERROR: 'invalid_input',
  NOT_FOUND: 'not_found',
  RESOURCE_NOT_FOUND: 'not_found',
  DEVICE_NOT_FOUND: 'not_found',
  COMMAND_NOT_FOUND: 'not_found',
  CONVERSATION_BUSY: 'conflict',
  REQUEST_ID_CONFLICT: 'conflict',
  COMMAND_RESULT_CONFLICT: 'conflict',
  RECOMMENDATION_ALREADY_RESPONDED: 'conflict',
  EXTERNAL_EVENT_READ_ONLY: 'conflict',
  STALE_COLLECTION_REVISION: 'conflict',
  CALENDAR_RECONNECT_REQUIRED: 'conflict',
  REMINDER_ALREADY_DELIVERED: 'conflict',
  RECOMMENDATION_EXPIRED: 'expired',
  FORBIDDEN: 'permission_denied',
  ADMIN_REQUIRED: 'permission_denied',
  COMMAND_DEVICE_MISMATCH: 'permission_denied',
  ACTIVITY_COLLECTION_DISABLED: 'permission_denied',
  EXTERNAL_ACTIVITY_COLLECTION_DISABLED: 'permission_denied',
  SERVICE_UNAVAILABLE: 'unavailable',
  UPSTREAM_ERROR: 'unavailable',
  INTERNAL_ERROR: 'unavailable'
}

function byStatus(status: number): Code {
  if (status === 401) return 'session_expired'
  if (status === 403) return 'permission_denied'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 410) return 'expired'
  if (status === 422) return 'invalid_input'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'unavailable'
  return 'internal'
}

/** The server's code decides when it is one we know; otherwise the HTTP status does. */
export function classifyServerError(status: number, serverCode: string | undefined): ClientError {
  return clientError((serverCode && BY_SERVER_CODE[serverCode]) || byStatus(status))
}
