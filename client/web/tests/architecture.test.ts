import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { checkArchitecture, checkClientImports, webRoot } from '../../scripts/check-architecture.mjs'

test('web and core have one-way dependencies without compatibility exports or cycles', () => {
  assert.deepEqual(checkArchitecture(), [])
})

test('architecture check rejects private core imports, compatibility exports, and UI adapter imports', () => {
  for (const source of [
    "import '@secure-messenger/client-core/src/index.ts'",
    "import '../../../packages/client-core/src/index.ts'",
    "export { ClientError } from '@secure-messenger/client-core'",
    "import '../shared/api/client.ts'",
  ]) {
    assert.notEqual(checkClientImports(new Map([[resolve(webRoot, 'app/probe.ts'), source]])).length, 0, source)
  }
  assert.deepEqual(checkClientImports(new Map([[resolve(webRoot, 'app/probe.ts'),
    "import { ClientError } from '@secure-messenger/client-core'"]])), [])
})

test('architecture check detects cycles including type imports and re-exports', () => {
  const a = resolve(webRoot, 'a.ts')
  const b = resolve(webRoot, 'b.ts')
  for (const backEdge of ["import type { A } from './a.ts'", "export * from './a.ts'", "type A = import('./a.ts').A"]) {
    const errors = checkClientImports(new Map([[a, "import './b.ts'"], [b, backEdge]]))
    assert.ok(errors.some((error: string) => error.includes('Circular dependency:')), backEdge)
  }
  assert.deepEqual(checkClientImports(new Map([[a, "import './b.ts'"], [b, 'export type B = string']])), [])
})
