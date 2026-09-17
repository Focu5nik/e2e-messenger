import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientError } from '@secure-messenger/client-core'
import { ApiError } from '../src/shared/api/errors.ts'
import { currentUserDto, deviceDto, timestamp, tokensDto, userDto } from './apiFixtures.ts'

const removedStorageKeys: string[] = []
const lockNames: string[] = []

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    removeItem(key: string) {
      removedStorageKeys.push(key)
    },
  },
})
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    clearTimeout() {},
    setTimeout() {
      return 1
    },
  },
})

function installLockManager(): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      locks: {
        async request<T>(name: string, operation: () => Promise<T>): Promise<T> {
          lockNames.push(name)
          return operation()
        },
      },
    },
  })
}

function removeLockManager(): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {},
  })
}

function tokenResponse(accessToken: string): Response {
  return Response.json({
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: 900,
  })
}

const { ApiClient } = await import('../src/shared/api/client.ts')

test('login uses the cookie lock and keeps only the access token in memory', async () => {
  removedStorageKeys.length = 0
  lockNames.length = 0
  installLockManager()
  const requests: Array<{ init: RequestInit; url: string }> = []

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    requests.push({ init, url })
    if (url.endsWith('/auth/login')) return tokenResponse('login-access-token')
    if (url.endsWith('/me')) {
      return Response.json({
        id: 'user-id',
        username: 'alice',
        status: 'active',
        created_at: '2026-09-01T00:00:00Z',
        device_id: 'device-id',
        session_id: 'session-id',
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  const client = new ApiClient()
  await client.login('alice', 'correct horse', { id: 'device-id', name: 'Browser' })
  assert.deepEqual(await client.getCurrentUser(), {
    id: 'user-id', username: 'alice', status: 'active', createdAt: '2026-09-01T00:00:00Z',
    deviceId: 'device-id', sessionId: 'session-id',
  })

  const loginRequest = requests[0]
  assert.equal(loginRequest.init.credentials, 'include')
  assert.deepEqual(JSON.parse(String(loginRequest.init.body)), {
    username: 'alice',
    password: 'correct horse',
    device_id: 'device-id',
    device_name: 'Browser',
  })
  assert.equal(
    new Headers(requests[1].init.headers).get('Authorization'),
    'Bearer login-access-token',
  )
  assert.deepEqual(lockNames, ['secure-messenger:auth-refresh'])
  assert.deepEqual(removedStorageKeys, ['messenger.refresh-token'])
})

test('restore sends no token body and treats a missing cookie as anonymous', async () => {
  installLockManager()
  let refreshInit: RequestInit | undefined
  globalThis.fetch = async (input, init = {}) => {
    assert.ok(String(input).endsWith('/auth/refresh'))
    refreshInit = init
    return Response.json({ detail: 'invalid or expired refresh token' }, { status: 401 })
  }

  const client = new ApiClient()
  assert.equal(await client.restoreSession(), false)
  assert.equal(refreshInit?.credentials, 'include')
  assert.equal(refreshInit?.body, undefined)
})

test('logout invalidates a late refresh result even without Web Locks', async () => {
  removeLockManager()
  let resolveRefresh: ((response: Response) => void) | undefined
  const refreshResponse = new Promise<Response>((resolve) => {
    resolveRefresh = resolve
  })
  const requests: Array<{ init: RequestInit; url: string }> = []

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    requests.push({ init, url })
    if (url.endsWith('/auth/refresh')) return refreshResponse
    if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 })
    throw new Error(`Unexpected request: ${url}`)
  }

  const client = new ApiClient()
  const restoring = client.restoreSession()
  await Promise.resolve()
  await client.logout()
  assert.ok(resolveRefresh)
  resolveRefresh(tokenResponse('stale-access-token'))

  assert.equal(await restoring, false)
  assert.equal(
    (client as unknown as { accessToken: string | null }).accessToken,
    null,
  )
  const logoutRequest = requests.find(({ url }) => url.endsWith('/auth/logout'))
  assert.equal(logoutRequest?.init.credentials, 'include')
})

test('logout invalidates a late login result without accepting its access token', async () => {
  removeLockManager()
  let resolveLogin!: (response: Response) => void
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/auth/login')) {
      return new Promise<Response>((resolve) => { resolveLogin = resolve })
    }
    assert.ok(String(input).endsWith('/auth/logout'))
    return new Response(null, { status: 204 })
  }
  const client = new ApiClient()
  const login = client.login('alice', 'password', { id: 'device', name: 'Browser' })
  const rejected = assert.rejects(login, (error: unknown) =>
    error instanceof ClientError && error.code === 'session_expired')
  await client.logout()
  resolveLogin(tokenResponse('stale-login-token'))
  await rejected
  assert.equal((client as unknown as { accessToken: string | null }).accessToken, null)
})

test('direct chat methods use authenticated V2 endpoints and encode path and search values', async () => {
  removeLockManager()
  const requests: Array<{ init: RequestInit; url: string }> = []
  const otherUser = {
    id: 'peer/id',
    username: 'bob smith',
    status: 'active',
    created_at: '2026-09-02T00:00:00Z',
  }
  const chat = {
    id: 'chat/id',
    type: 'DIRECT',
    created_at: '2026-09-03T00:00:00Z',
    other_user: otherUser,
  }

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    requests.push({ init, url })
    if (url.endsWith('/auth/login')) return tokenResponse('v2-access-token')
    if (url.endsWith('/users?search=bob+smith')) return Response.json([otherUser])
    if (url.endsWith('/chats/direct/peer%2Fid')) return Response.json(chat)
    if (url.endsWith('/chats')) return Response.json([chat])
    if (url.endsWith('/chats/chat%2Fid')) return Response.json(chat)
    throw new Error(`Unexpected request: ${url}`)
  }

  const client = new ApiClient()
  await client.login('alice', 'correct horse', { id: 'device-id', name: 'Browser' })

  const domainUser = { id: 'peer/id', username: 'bob smith', status: 'active', createdAt: otherUser.created_at }
  const domainChat = { id: 'chat/id', type: 'DIRECT', createdAt: chat.created_at, otherUser: domainUser }
  assert.deepEqual(await client.searchUsers('bob smith'), [domainUser])
  assert.deepEqual(await client.createDirectChat('peer/id'), domainChat)
  assert.deepEqual(await client.getChats(), [domainChat])
  assert.deepEqual(await client.getChat('chat/id'), domainChat)

  const v2Requests = requests.slice(1)
  assert.deepEqual(v2Requests.map(({ init }) => init.method ?? 'GET'), [
    'GET',
    'POST',
    'GET',
    'GET',
  ])
  for (const { init } of v2Requests) {
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer v2-access-token')
  }
  assert.equal(v2Requests[1].init.body, undefined)
})

test('messaging methods use the V3 device, send, and mailbox contracts', async () => {
  removeLockManager()
  const requests: Array<{ init: RequestInit; url: string }> = []
  const command = {
    chat_id: 'chat/id',
    client_message_id: 'client-message-id',
    envelopes: [{
      recipient_device_id: 'device/id',
      protocol_version: 0,
      envelope_type: 'PLAINTEXT',
      payload: 'aGVsbG8=',
    }],
  }

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    requests.push({ init, url })
    if (url.endsWith('/auth/login')) return tokenResponse('v3-access-token')
    if (url.endsWith('/chats/chat%2Fid/destination-devices')) {
      return Response.json([{ id: 'device/id', protocol_version: 0 }])
    }
    if (url.endsWith('/messages')) {
      return Response.json({
        id: 'message-id',
        chat_id: 'chat/id',
        sender_user_id: 'user-id',
        sender_device_id: 'sender-device-id',
        client_message_id: command.client_message_id,
        created_at: '2026-09-07T00:00:00Z',
        envelopes: [],
      })
    }
    if (url.endsWith('/messages/mailbox?after_seq=41&limit=25')) {
      return Response.json({ envelopes: [], next_seq: 41, has_more: false })
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  const client = new ApiClient()
  await client.login('alice', 'correct horse', { id: 'device-id', name: 'Browser' })

  assert.deepEqual(await client.getDestinationDevices('chat/id'), [
    { id: 'device/id', protocolVersion: 0 },
  ])
  assert.deepEqual(await client.sendMessage(command), {
    id: 'message-id', chatId: 'chat/id', senderUserId: 'user-id', senderDeviceId: 'sender-device-id',
    clientMessageId: command.client_message_id, createdAt: '2026-09-07T00:00:00Z', envelopes: [],
  })
  assert.deepEqual(await client.getMailbox(41, 25), {
    envelopes: [],
    nextSeq: 41,
    hasMore: false,
  })

  const v3Requests = requests.slice(1)
  assert.deepEqual(v3Requests.map(({ init }) => init.method ?? 'GET'), ['GET', 'POST', 'GET'])
  assert.deepEqual(JSON.parse(String(v3Requests[1].init.body)), command)
  for (const { init } of v3Requests) {
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer v3-access-token')
  }
})

test('structured API errors preserve the retryable delivery target code', async () => {
  removeLockManager()
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/auth/login')) return tokenResponse('v3-access-token')
    if (url.endsWith('/messages')) {
      return Response.json({
        detail: {
          code: 'delivery_targets_changed',
          message: 'Destination devices changed; refresh and retry.',
        },
      }, { status: 409 })
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  const client = new ApiClient()
  await client.login('alice', 'correct horse', { id: 'device-id', name: 'Browser' })

  await assert.rejects(
    client.sendMessage({ chat_id: 'chat-id', client_message_id: 'client-id', envelopes: [] }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.ok(error instanceof ClientError)
      assert.equal(error.status, 409)
      assert.equal(error.code, 'delivery_targets_changed')
      assert.equal(error.serverCode, 'delivery_targets_changed')
      assert.equal(error.message, 'Destination devices changed; refresh and retry.')
      return true
    },
  )
})

test('WebSocket auth shares memory tokens and refresh and reports logout immediately', async () => {
  removeLockManager()
  let refreshCount = 0
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/auth/login')) return tokenResponse('initial-access')
    if (url.endsWith('/auth/refresh')) { refreshCount += 1; return tokenResponse('fresh-access') }
    if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 })
    throw new Error(`Unexpected request: ${url}`)
  }
  const client = new ApiClient()
  await client.login('alice', 'password', { id: 'device', name: 'Browser' })
  assert.equal(await client.getAccessToken(), 'initial-access')
  const tokens = await Promise.all([client.getAccessToken(true), client.getAccessToken(true)])
  assert.deepEqual(tokens, ['fresh-access', 'fresh-access'])
  assert.equal(refreshCount, 1)
  let cleared = false
  const unsubscribe = client.onSessionCleared(() => { cleared = true })
  const logout = client.logout()
  assert.equal(cleared, true)
  await logout
  unsubscribe()
})

test('WebSocket token acquisition rejects a refresh that completes after logout', async () => {
  removeLockManager()
  let resolveRefresh: ((response: Response) => void) | undefined
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/auth/refresh')) return new Promise((resolve) => { resolveRefresh = resolve })
    return new Response(null, { status: 204 })
  }
  const client = new ApiClient()
  const token = client.getAccessToken()
  await client.logout()
  resolveRefresh?.(tokenResponse('stale-access'))
  await assert.rejects(token, (error: unknown) => error instanceof ApiError && error.status === 401)
})

test('register, restore, account and device endpoints map responses while preserving requests', async () => {
  removeLockManager()
  const requests: Array<{ path: string; init: RequestInit }> = []
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname
    requests.push({ path, init })
    if (path === '/auth/register') return Response.json(userDto, { status: 201 })
    if (path === '/auth/refresh') return Response.json(tokensDto)
    if (path === '/me') return Response.json(currentUserDto)
    if (path === '/devices') return Response.json([deviceDto])
    if (path === '/devices/device%2F1' || path === '/auth/logout') return new Response(null, { status: 204 })
    throw new Error(`Unexpected request: ${path}`)
  }
  const client = new ApiClient()
  assert.deepEqual(await client.register('alice', 'password'), {
    id: 'user-1', username: 'alice', status: 'active', createdAt: timestamp,
  })
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { username: 'alice', password: 'password' })
  assert.equal(await client.restoreSession(), true)
  assert.equal((await client.getCurrentUser()).deviceId, 'device-1')
  assert.deepEqual(await client.getDevices(), [{
    id: 'device-1', name: 'Browser', protocolVersion: 0, createdAt: timestamp,
    lastSeenAt: timestamp, revokedAt: null, isCurrent: true,
  }])
  assert.equal(await client.revokeDevice('device/1'), undefined)
  assert.equal(requests.at(-1)?.init.method, 'DELETE')
  await client.logout()
  assert.equal(requests.at(-1)?.init.credentials, 'include')
})

test('every JSON endpoint rejects malformed success responses at the HTTP boundary', async () => {
  removeLockManager()
  const calls: Array<(client: InstanceType<typeof ApiClient>) => Promise<unknown>> = [
    (client) => client.register('alice', 'password'),
    (client) => client.login('alice', 'password', { id: 'device-1', name: 'Browser' }),
    (client) => client.getAccessToken(true),
    (client) => client.getCurrentUser(), (client) => client.getDevices(),
    (client) => client.searchUsers('alice'), (client) => client.getChats(),
    (client) => client.getChat('chat-1'), (client) => client.createDirectChat('user-1'),
    (client) => client.getDestinationDevices('chat-1'),
    (client) => client.sendMessage({ chat_id: 'chat-1', client_message_id: 'client-1', envelopes: [] }),
    (client) => client.getMailbox(0),
  ]
  for (const call of calls) {
    for (const response of [() => Response.json({}), () => new Response('not JSON'), () => new Response(null, { status: 204 })]) {
      globalThis.fetch = async () => Response.json(tokensDto)
      const client = new ApiClient()
      await client.login('alice', 'password', { id: 'device-1', name: 'Browser' })
      globalThis.fetch = async () => response()
      await assert.rejects(call(client), (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.code, 'invalid_response')
        assert.equal(error.message, 'The server returned an invalid response.')
        return true
      })
      globalThis.fetch = async () => new Response(null, { status: 204 })
      await client.logout()
    }
  }
})

test('malformed error bodies retain HTTP status and safe fallback text', async () => {
  for (const response of [
    () => Response.json({ detail: [null, { msg: 42 }] }, { status: 422 }),
    () => Response.json({ detail: { code: 42, message: {} } }, { status: 422 }),
    () => new Response('not JSON', { status: 422 }),
  ]) {
    globalThis.fetch = async () => response()
    await assert.rejects(new ApiClient().register('alice', 'password'), (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 422)
      assert.equal(error.message, 'Request failed (422)')
      assert.equal(error.code, 'validation_error')
      assert.equal(error.serverCode, null)
      return true
    })
  }
})

test('login recovery and session expiry expose application codes without changing messages', async () => {
  for (const [status, detail, code] of [
    [403, 'device is revoked', 'device_revoked'],
    [403, 'account is not active', 'forbidden'],
    [401, 'invalid username or password', 'invalid_credentials'],
  ] as const) {
    globalThis.fetch = async () => Response.json({ detail }, { status })
    const client = new ApiClient()
    await assert.rejects(client.login('alice', 'password', { id: 'device-1', name: 'Browser' }), (error: unknown) => {
      assert.ok(error instanceof ClientError)
      assert.equal(error.code, code)
      assert.equal(error.message, detail)
      return true
    })
  }
  globalThis.fetch = async () => Response.json({ detail: 'invalid or expired refresh token' }, { status: 401 })
  await assert.rejects(new ApiClient().getAccessToken(), (error: unknown) => error instanceof ClientError && error.code === 'session_expired')
  globalThis.fetch = async () => { throw new TypeError('Network unavailable') }
  await assert.rejects(new ApiClient().register('alice', 'password'), (error: unknown) => error instanceof ClientError && error.code === 'network_error')
})

test('session events support multiple subscribers and independent, repeatable cleanup', async () => {
  removeLockManager()
  let refreshStatus = 401
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname
    if (path === '/auth/login') return tokenResponse('login-access')
    if (path === '/auth/logout') return new Response(null, { status: 204 })
    assert.equal(path, '/auth/refresh')
    return Response.json({ detail: 'Refresh failed' }, { status: refreshStatus })
  }
  const client = new ApiClient()
  const events: string[] = []
  const unsubscribeExpired = client.onSessionExpired(() => events.push('expired-1'))
  const unsubscribeCleared = client.onSessionCleared(() => events.push('cleared-1'))
  client.onSessionExpired(() => events.push('expired-2'))
  client.onSessionCleared(() => events.push('cleared-2'))

  assert.equal(await client.restoreSession(), false)
  assert.deepEqual(events.splice(0), ['cleared-1', 'cleared-2'])
  await client.login('alice', 'password', { id: 'device', name: 'Browser' })
  assert.deepEqual(events.splice(0), ['cleared-1', 'cleared-2'])
  await client.logout()
  assert.deepEqual(events.splice(0), ['cleared-1', 'cleared-2'])

  await assert.rejects(client.getAccessToken(true), (error: unknown) =>
    error instanceof ClientError && error.code === 'session_expired')
  assert.deepEqual(events.splice(0), ['cleared-1', 'cleared-2', 'expired-1', 'expired-2'])
  unsubscribeExpired()
  unsubscribeExpired()
  unsubscribeCleared()
  unsubscribeCleared()
  await assert.rejects(client.getAccessToken(true))
  assert.deepEqual(events.splice(0), ['cleared-2', 'expired-2'])

  refreshStatus = 503
  await assert.rejects(client.getAccessToken(true))
  assert.deepEqual(events, [])
})

test('authenticated 401 responses expire subscribers only after refresh or the retried request fails', async () => {
  for (const refreshRejected of [true, false]) {
    removeLockManager()
    const authorizations: Array<string | null> = []
    let refreshes = 0
    globalThis.fetch = async (input, init = {}) => {
      const path = new URL(String(input)).pathname
      if (path === '/auth/login') return tokenResponse('initial-access')
      if (path === '/auth/refresh') {
        refreshes += 1
        assert.equal(init.credentials, 'include')
        assert.equal(init.body, undefined)
        return refreshRejected
          ? Response.json({ detail: 'Refresh expired' }, { status: 401 })
          : tokenResponse('rotated-access')
      }
      assert.equal(path, '/me')
      authorizations.push(new Headers(init.headers).get('Authorization'))
      return Response.json({ detail: 'Access expired' }, { status: 401 })
    }
    const client = new ApiClient()
    await client.login('alice', 'password', { id: 'device', name: 'Browser' })
    const events: string[] = []
    client.onSessionCleared(() => events.push('cleared'))
    client.onSessionExpired(() => events.push('expired'))
    await assert.rejects(client.getCurrentUser(), (error: unknown) =>
      error instanceof ClientError && error.code === 'session_expired')
    assert.equal(refreshes, 1)
    assert.deepEqual(authorizations, refreshRejected
      ? ['Bearer initial-access'] : ['Bearer initial-access', 'Bearer rotated-access'])
    assert.deepEqual(events, ['cleared', 'expired'])
  }
})

test('concurrent clients serialize cookie refreshes with Web Locks and coalesce each client refresh', async () => {
  let tail = Promise.resolve()
  const names: string[] = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      locks: {
        request<T>(name: string, operation: () => Promise<T>): Promise<T> {
          names.push(name)
          const result = tail.then(operation)
          tail = result.then(() => undefined, () => undefined)
          return result
        },
      },
    },
  })
  let releaseFirst: ((response: Response) => void) | undefined
  let refreshes = 0
  globalThis.fetch = async (input, init = {}) => {
    assert.ok(String(input).endsWith('/auth/refresh'))
    assert.equal(init.credentials, 'include')
    assert.equal(init.body, undefined)
    refreshes += 1
    return refreshes === 1
      ? new Promise<Response>((resolve) => { releaseFirst = resolve })
      : tokenResponse('second-client-access')
  }
  const first = new ApiClient()
  const second = new ApiClient()
  const tokens = Promise.all([first.getAccessToken(true), first.getAccessToken(true), second.getAccessToken(true)])
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(refreshes, 1)
  assert.ok(releaseFirst)
  releaseFirst(tokenResponse('first-client-access'))
  assert.deepEqual(await tokens, ['first-client-access', 'first-client-access', 'second-client-access'])
  assert.equal(refreshes, 2)
  assert.deepEqual(names, ['secure-messenger:auth-refresh', 'secure-messenger:auth-refresh'])
})

test('scheduled refresh rotates memory tokens, retries transient failures, and clears timers on logout', async (t) => {
  removeLockManager()
  const timers = new Map<number, { callback: () => void; delay: number | undefined }>()
  let nextTimer = 0
  t.mock.method(window, 'setTimeout', (handler: TimerHandler, delay?: number) => {
    assert.equal(typeof handler, 'function')
    const id = ++nextTimer
    timers.set(id, { callback: () => (handler as () => void)(), delay })
    return id
  })
  t.mock.method(window, 'clearTimeout', (id: number) => { timers.delete(id) })
  let refreshes = 0
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname
    if (path === '/auth/login') return tokenResponse('initial-access')
    if (path === '/auth/logout') return new Response(null, { status: 204 })
    assert.equal(path, '/auth/refresh')
    refreshes += 1
    return refreshes === 1
      ? Response.json({ detail: 'Unavailable' }, { status: 503 })
      : tokenResponse('rotated-access')
  }
  const client = new ApiClient()
  await client.login('alice', 'password', { id: 'device', name: 'Browser' })
  let expired = 0
  client.onSessionExpired(() => { expired += 1 })

  async function fireTimer(expectedDelay: number): Promise<void> {
    assert.equal(timers.size, 1)
    const [id, timer] = [...timers.entries()][0]
    assert.equal(timer.delay, expectedDelay)
    timers.delete(id)
    timer.callback()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  await fireTimer(870_000)
  assert.equal(await client.getAccessToken(), 'initial-access')
  await fireTimer(30_000)
  assert.equal(await client.getAccessToken(), 'rotated-access')
  assert.equal([...timers.values()][0].delay, 870_000)
  assert.equal(refreshes, 2)
  assert.equal(expired, 0)
  await client.logout()
  assert.equal(timers.size, 0)
})
