import { ClientError, type ClientErrorCode } from '@secure-messenger/client-core'

function applicationCode(status: number, message: string, serverCode: string | null): ClientErrorCode {
  if (status === 0) return 'network_error'
  if (status === 401) return 'session_expired'
  if (status === 403 && message === 'device is revoked') return 'device_revoked'
  if (status === 409 && serverCode === 'delivery_targets_changed') return 'delivery_targets_changed'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 422) return 'validation_error'
  if (status >= 500) return 'server_error'
  return 'request_failed'
}

// HTTP metadata stays in the web adapter. Unknown server codes must not become
// application codes or accidentally activate recovery/retry policies.
export class ApiError extends ClientError {
  readonly status: number
  readonly serverCode: string | null

  constructor(message: string, status: number, serverCode: string | null = null, code?: ClientErrorCode) {
    super(message, code ?? applicationCode(status, message, serverCode))
    this.name = 'ApiError'
    this.status = status
    this.serverCode = serverCode
  }
}
