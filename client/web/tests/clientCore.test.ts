import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('the frontend imports client-core from the local workspace', async () => {
  assert.equal(
    realpathSync(fileURLToPath(import.meta.resolve('@secure-messenger/client-core'))),
    realpathSync(fileURLToPath(new URL('../../packages/client-core/src/index.ts', import.meta.url))),
  )
  await import('@secure-messenger/client-core')
})
