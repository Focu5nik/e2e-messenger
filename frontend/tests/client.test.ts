import assert from 'node:assert/strict'
import test from 'node:test'

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

const { ApiClient, ApiError } = await import('../src/shared/api/client.ts')

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
  await client.getCurrentUser()

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

  assert.deepEqual(await client.searchUsers('bob smith'), [otherUser])
  assert.deepEqual(await client.createDirectChat('peer/id'), chat)
  assert.deepEqual(await client.getChats(), [chat])
  assert.deepEqual(await client.getChat('chat/id'), chat)

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
    { id: 'device/id', protocol_version: 0 },
  ])
  assert.equal((await client.sendMessage(command)).id, 'message-id')
  assert.deepEqual(await client.getMailbox(41, 25), {
    envelopes: [],
    next_seq: 41,
    has_more: false,
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
      assert.equal(error.status, 409)
      assert.equal(error.code, 'delivery_targets_changed')
      assert.equal(error.message, 'Destination devices changed; refresh and retry.')
      return true
    },
  )
})
