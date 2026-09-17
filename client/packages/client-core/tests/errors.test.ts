import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientError } from '@secure-messenger/client-core'

test('ClientError is usable without transport metadata or platform globals', async () => {
  const error = new ClientError('The device needs replacement.', 'device_revoked')
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'ClientError')
  assert.equal(error.message, 'The device needs replacement.')
  assert.equal(error.code, 'device_revoked')
  assert.equal('status' in error, false)
  await assert.rejects(Promise.reject(error), (caught: unknown) => caught === error)
})
