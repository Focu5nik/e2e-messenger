import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { checkBoundaries, checkSource, sourceRoot } from '../scripts/check-boundaries.mjs'

const probeFile = resolve(sourceRoot, '__boundary_probe__.ts')

function compileProbe(source: string) {
  const configPath = fileURLToPath(new URL('../tsconfig.json', import.meta.url))
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath))
  assert.deepEqual(parsed.errors, [])
  const host = ts.createCompilerHost(parsed.options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    resolve(fileName) === probeFile
      ? ts.createSourceFile(fileName, source, languageVersion, true)
      : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
  return ts.getPreEmitDiagnostics(ts.createProgram([probeFile], parsed.options, host))
}

test('core compiles ES2023 and vanilla Zustand without platform types', () => {
  const diagnostics = compileProbe(`
    import { createStore } from 'zustand/vanilla'
    const store = createStore<{ count: number }>(() => ({ count: 0 }))
    store.setState({ count: [3, 1, 2].toSorted()[0] })
  `)
  assert.deepEqual(diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')), [])
})

test('core compilation rejects browser, Node, and React globals', () => {
  const globals = ['window', 'document', 'navigator', 'localStorage', 'WebSocket',
    'fetch', 'crypto', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', 'setTimeout',
    'process', 'Buffer', 'React']
  const diagnostics = compileProbe(`export {};\n${globals.map((name) => `${name};`).join('\n')}`)
  for (const name of globals) {
    assert.ok(diagnostics.some((item) => item.category === ts.DiagnosticCategory.Error &&
      ts.flattenDiagnosticMessageText(item.messageText, '\n').includes(`Cannot find name '${name}'`)), name)
  }
})

test('gateway contracts and ClientError compile with platform-free implementations', () => {
  const diagnostics = compileProbe(`
    import { ClientError } from '@secure-messenger/client-core'
    import type { SessionGateway, AccountGateway, ChatGateway, MessagingGateway, RealtimeGateway } from '@secure-messenger/client-core'
    const fail = async (): Promise<never> => { throw new ClientError('Offline', 'network_error') }
    const subscribe = () => () => {}
    const session: SessionGateway = {
      register: fail, login: fail, restoreSession: fail, logout: fail,
      onSessionExpired: subscribe, onSessionCleared: subscribe,
    }
    const account: AccountGateway = { getCurrentUser: fail, getDevices: fail, revokeDevice: fail }
    const chats: ChatGateway = { searchUsers: fail, getChats: fail, getChat: fail, createDirectChat: fail }
    const messages: MessagingGateway = { getDestinationDevices: fail, sendMessage: fail, getMailbox: fail }
    const realtime: RealtimeGateway = {
      ready: false, start() {}, stop() {}, sendMessage: fail, onMessage: subscribe, onReady: subscribe,
    }
  `)
  assert.deepEqual(diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')), [])
})

test('boundary check rejects platform imports, re-exports, type imports, and ambient references', () => {
  const forbidden = [
    "import React from 'react'",
    "import type { View } from 'react-native'",
    "import { create } from 'zustand'",
    "import 'zustand/react'",
    "import 'vite/client'",
    "import 'node:fs'",
    "import '../../../web/src/main.tsx'",
    "export * from 'react'",
    "type Node = import('react').ReactNode",
    "import React = require('react')",
    "import('react')",
    'import(moduleName)',
    'import.meta',
    '/// <reference types="node" />',
    '/// <reference lib="dom" />',
    '/// <reference path="../../../web/src/vite-env.d.ts" />',
  ]
  for (const source of forbidden) {
    assert.notEqual(checkSource(source, probeFile).length, 0, source)
  }
  assert.deepEqual(checkSource(`
    import { createStore } from 'zustand/vanilla'
    export * from './index.ts'
    // Platform names in documentation are harmless: window, import.meta.
    const label = 'react'
  `, probeFile), [])
})

test('all core source files respect the import boundary', () => {
  assert.deepEqual(checkBoundaries(), [])
})
