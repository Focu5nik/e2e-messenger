import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import viteConfig from '../vite.config.ts'

test('Vite loads environment files from the web workspace', async () => {
  assert.equal(typeof viteConfig, 'function')
  if (typeof viteConfig !== 'function') throw new Error('Expected a Vite configuration factory')
  const config = await viteConfig({ command: 'serve', mode: 'test' })
  assert.equal(config.envDir, fileURLToPath(new URL('../', import.meta.url)))
  assert.equal(config.server?.strictPort, true)
})
