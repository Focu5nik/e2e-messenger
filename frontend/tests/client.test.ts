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
