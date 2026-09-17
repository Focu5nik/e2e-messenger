export type ClientErrorCode =
  | 'device_revoked'
  | 'delivery_targets_changed'
  | 'no_recipient_devices'
  | 'session_expired'
  | 'invalid_credentials'
  | 'network_error'
  | 'delivery_unconfirmed'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation_error'
  | 'server_error'
  | 'invalid_response'
  | 'request_failed'

// Application decisions use this code, independent of transport status or text.
export class ClientError extends Error {
  readonly code: ClientErrorCode

  constructor(message: string, code: ClientErrorCode) {
    super(message)
    this.name = 'ClientError'
    this.code = code
  }
}
