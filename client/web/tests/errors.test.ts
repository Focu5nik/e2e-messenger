import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientError, type ClientErrorCode } from '@secure-messenger/client-core'
import { ApiError } from '../src/shared/api/errors.ts'

test('HTTP and realtime error metadata map to stable application codes', () => {
  const cases: Array<[number, string, string | null, ClientErrorCode]> = [
    [403, 'device is revoked', null, 'device_revoked'],
    [403, 'Account disabled', null, 'forbidden'],
    [401, 'device is revoked', null, 'session_expired'],
    [500, 'device is revoked', null, 'server_error'],
    [409, 'Destinations changed.', 'delivery_targets_changed', 'delivery_targets_changed'],
    [409, 'Conflict', null, 'conflict'],
    [403, 'Wrong status', 'delivery_targets_changed', 'forbidden'],
    [500, 'Wrong status', 'delivery_targets_changed', 'server_error'],
    [409, 'Unknown server code', 'future_code', 'conflict'],
    [403, 'Not revoked', 'device_revoked', 'forbidden'],
    [401, 'invalid or expired refresh token', null, 'session_expired'],
    [0, 'Cannot reach server', null, 'network_error'],
    [404, 'chat not found', null, 'not_found'],
    [422, 'Validation failed', null, 'validation_error'],
    [503, 'Unavailable', null, 'server_error'],
    [400, 'Invalid request', null, 'request_failed'],
  ]
  for (const [status, message, serverCode, code] of cases) {
    const error = new ApiError(message, status, serverCode)
    assert.ok(error instanceof ClientError)
    assert.equal(error.code, code)
    assert.equal(error.message, message)
    assert.equal(error.status, status)
    assert.equal(error.serverCode, serverCode)
  }
})
