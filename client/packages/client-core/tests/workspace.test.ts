import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

test('the client-core package entry point loads in Node without a bundler', async () => {
  await import('@secure-messenger/client-core')
})

test('documented public API matches the compiled package exports and runtime values', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.exports, { '.': { types: './src/index.ts', import: './src/index.ts' } })
  const configPath = fileURLToPath(new URL('../tsconfig.json', import.meta.url))
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath))
  assert.deepEqual(parsed.errors, [])
  const entry = fileURLToPath(new URL(`../${manifest.exports['.'].types}`, import.meta.url))
  const program = ts.createProgram([entry], parsed.options)
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')), [])
  const checker = program.getTypeChecker()
  const symbol = checker.getSymbolAtLocation(program.getSourceFile(entry)!)!
  const names = checker.getExportsOfModule(symbol).map((item) => item.name).sort()
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const inventory = readme.split('<!-- public-api:start -->')[1]?.split('<!-- public-api:end -->')[0]
  assert.ok(inventory)
  const documented = [...inventory.matchAll(/`(\w+)`/g)].map((match) => match[1]).sort()
  assert.deepEqual(documented, names)
  const runtime = inventory.split('\n').filter((line) => line.startsWith('| Runtime:'))
    .flatMap((line) => [...line.matchAll(/`(\w+)`/g)].map((match) => match[1])).sort()
  assert.deepEqual(Object.keys(await import('@secure-messenger/client-core')).sort(), runtime)
})
