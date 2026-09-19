import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ClientError, createSessionStore,
  type AccountGateway, type CurrentUser, type Device, type DeviceIdentity, type SessionGateway,
} from '../src/index.ts'

const identity: DeviceIdentity = { id: 'current-device', name: 'This device' }
const replacement: DeviceIdentity = { id: 'replacement-device', name: 'Replacement device' }
const user: CurrentUser = {
  id: 'alice-id', username: 'alice', status: 'active', createdAt: '2026-09-13T00:00:00Z',
  deviceId: identity.id, sessionId: 'session-id',
}
const devices: Device[] = [identity, { id: 'remote-device', name: 'Remote device' }].map((device) => ({
  ...device, protocolVersion: 0, createdAt: user.createdAt, lastSeenAt: user.createdAt,
  revokedAt: null, isCurrent: device.id === identity.id,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function setup(restored = true) {
  const calls: string[] = []
  const expired = new Set<() => void>()
  const cleared = new Set<() => void>()
  const session: SessionGateway = {
    async register(username, password) {
      assert.equal(username, 'alice')
      assert.equal(password, ' test-password ')
      calls.push('register')
      return user
    },
    async login(username, password, device) {
      assert.equal(username, 'alice')
      assert.equal(password, ' test-password ')
      calls.push(`login:${device.id}`)
      for (const handler of cleared) handler()
    },
    async restoreSession() { calls.push('restore'); return restored },
    async logout() { calls.push('logout'); for (const handler of cleared) handler() },
    onSessionExpired(handler) { expired.add(handler); return () => { expired.delete(handler) } },
    onSessionCleared(handler) { cleared.add(handler); return () => { cleared.delete(handler) } },
  }
  const account: AccountGateway = {
    async getCurrentUser() { calls.push('user'); return user },
    async getDevices() { calls.push('devices'); return devices },
    async revokeDevice(id) { calls.push(`revoke:${id}`) },
  }
  const identities = {
    async get() { calls.push('identity'); return identity },
    async replace() { calls.push('replace'); return replacement },
  }
  const store = createSessionStore({ session, account, identities })
  return { store, session, account, identities, calls, expired }
}

test('restoration waits for identity and both account responses before authenticating', async () => {
  const { store, identities, account, calls } = setup()
  const savedIdentity = deferred<DeviceIdentity>()
  const currentUser = deferred<CurrentUser>()
  const currentDevices = deferred<Device[]>()
  identities.get = () => savedIdentity.promise
  account.getCurrentUser = () => { calls.push('user'); return currentUser.promise }
  account.getDevices = () => { calls.push('devices'); return currentDevices.promise }
  const restoring = store.getState().restore()
  assert.equal(store.getState().phase, 'restoring')
  assert.deepEqual(calls, [])
  savedIdentity.resolve(identity)
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(calls, ['restore', 'user', 'devices'])
  currentUser.resolve(user)
  await Promise.resolve()
  assert.equal(store.getState().user, null)
  currentDevices.resolve(devices)
  await restoring
  assert.equal(store.getState().phase, 'authenticated')
  assert.deepEqual(store.getState().user, user)
  assert.deepEqual(store.getState().devices, devices)
  store.getState().dispose()
})

test('anonymous restoration skips account loading and has no expiry warning', async () => {
  const { store, calls } = setup(false)
  await store.getState().restore()
  assert.deepEqual(calls, ['identity', 'restore'])
  assert.equal(store.getState().phase, 'anonymous')
  assert.equal(store.getState().authError, null)
  assert.deepEqual(store.getState().deviceIdentity, identity)
})

test('identity, restoration, and account failures return to anonymous with the error', async () => {
  for (const stage of ['identity', 'restore', 'user', 'devices']) {
    const { store, identities, session, account } = setup()
    const fail = async () => { throw new Error(`${stage} failed`) }
    if (stage === 'identity') identities.get = fail
    if (stage === 'restore') session.restoreSession = fail
    if (stage === 'user') account.getCurrentUser = fail
    if (stage === 'devices') account.getDevices = fail
    await store.getState().restore()
    assert.equal(store.getState().phase, 'anonymous')
    assert.equal(store.getState().authError, `${stage} failed`)
    assert.equal(store.getState().user, null)
    assert.deepEqual(store.getState().devices, [])
  }
})

test('login normalizes only the username, loads the account, and never stores credentials', async () => {
  const { store, calls } = setup(false)
  await store.getState().restore()
  calls.length = 0
  await store.getState().login('  alice  ', ' test-password ')
  assert.deepEqual(calls, ['identity', `login:${identity.id}`, 'user', 'devices'])
  assert.equal(store.getState().phase, 'authenticated')
  assert.equal(store.getState().submitting, false)
  assert.doesNotMatch(JSON.stringify(store.getState()), /test-password/)
  assert.equal('password' in store.getState(), false)
  assert.equal('username' in store.getState(), false)
})

test('login failure does not replace identity or load account and allows a retry', async () => {
  const { store, session, calls } = setup(false)
  await store.getState().restore()
  const login = session.login
  session.login = async () => { throw new ClientError('Invalid credentials', 'invalid_credentials') }
  await store.getState().login('alice', ' test-password ')
  assert.equal(store.getState().authError, 'Invalid credentials')
  assert.equal(store.getState().submitting, false)
  assert.equal(store.getState().phase, 'anonymous')
  assert.deepEqual(calls, ['identity', 'restore', 'identity'])
  store.getState().clearAuthError()
  assert.equal(store.getState().authError, null)
  session.login = login
  await store.getState().login('alice', ' test-password ')
  assert.equal(store.getState().phase, 'authenticated')
})

test('registration reports success, logs in once, and loads the account in order', async () => {
  const { store, calls } = setup(false)
  await store.getState().restore()
  calls.length = 0
  assert.equal(await store.getState().register('  alice  ', ' test-password '), true)
  assert.deepEqual(calls, ['register', 'identity', `login:${identity.id}`, 'user', 'devices'])
  assert.equal(store.getState().phase, 'authenticated')
})

test('registration failure skips login; successful registration with failed login is reported separately', async () => {
  for (const registrationFails of [true, false]) {
    const { store, session, calls } = setup(false)
    await store.getState().restore()
    const register = session.register
    session.register = async (...args) => {
      if (registrationFails) throw new ClientError('Username taken', 'conflict')
      return register(...args)
    }
    session.login = async () => { calls.push('login'); throw new Error('Login failed') }
    assert.equal(await store.getState().register('alice', ' test-password '), !registrationFails)
    assert.equal(calls.includes('login'), !registrationFails)
    assert.equal(store.getState().authError, registrationFails ? 'Username taken' : 'Login failed')
    assert.equal(store.getState().submitting, false)
  }
})

test('revoked identity recovery waits for persisted replacement and retries only once', async () => {
  for (const retryFails of [false, true]) {
    const { store, session, identities, account, calls } = setup(false)
    await store.getState().restore()
    const savedReplacement = deferred<DeviceIdentity>()
    identities.replace = () => savedReplacement.promise
    let attempts = 0
    session.login = async (_username, _password, device) => {
      calls.push(`login:${device.id}`)
      if (++attempts === 1 || retryFails) throw new ClientError('Revoked', 'device_revoked')
    }
    account.getCurrentUser = async () => { calls.push('user'); return { ...user, deviceId: replacement.id } }
    const login = store.getState().login('alice', ' test-password ')
    await Promise.resolve()
    assert.equal(attempts, 1)
    assert.deepEqual(store.getState().deviceIdentity, identity)
    savedReplacement.resolve(replacement)
    await login
    assert.equal(attempts, 2)
    assert.deepEqual(store.getState().deviceIdentity, replacement)
    assert.equal(store.getState().phase, retryFails ? 'anonymous' : 'authenticated')
    assert.equal(store.getState().authError, retryFails ? 'Revoked' : null)
    assert.equal(calls.includes('user'), !retryFails)
  }
})

test('replacement storage failure stops login recovery and keeps the previous identity', async () => {
  const { store, session, identities } = setup(false)
  await store.getState().restore()
  let attempts = 0
  session.login = async () => { attempts += 1; throw new ClientError('Revoked', 'device_revoked') }
  identities.replace = async () => { throw new Error('Storage unavailable') }
  await store.getState().login('alice', ' test-password ')
  assert.equal(attempts, 1)
  assert.deepEqual(store.getState().deviceIdentity, identity)
  assert.equal(store.getState().authError, 'Storage unavailable')
})

test('remote revocation refreshes devices and retains the current session', async () => {
  const { store, account, calls } = setup()
  await store.getState().restore()
  calls.length = 0
  const refreshed = [devices[0], { ...devices[1], revokedAt: user.createdAt }]
  account.getDevices = async () => { calls.push('devices'); return refreshed }
  await store.getState().revokeDevice(devices[1].id)
  assert.deepEqual(calls, [`revoke:${devices[1].id}`, 'devices'])
  assert.deepEqual(store.getState().devices, refreshed)
  assert.equal(store.getState().phase, 'authenticated')
  assert.equal(store.getState().busyDeviceId, null)
})

test('current-device revocation logs out and preserves the cookie-clearing warning on failure', async () => {
  for (const logoutFails of [false, true]) {
    const { store, session, calls } = setup()
    await store.getState().restore()
    calls.length = 0
    session.logout = async () => { calls.push('logout'); if (logoutFails) throw new Error('Offline') }
    await store.getState().revokeDevice(identity.id)
    assert.deepEqual(calls, [`revoke:${identity.id}`, 'logout'])
    assert.equal(store.getState().phase, 'anonymous')
    assert.equal(store.getState().user, null)
    assert.deepEqual(store.getState().devices, [])
    assert.equal(store.getState().busyDeviceId, null)
    assert.equal(store.getState().authError, logoutFails
      ? 'Device revoked, but its browser cookie could not be cleared: Offline' : null)
  }
})

test('revocation and device-refresh failures stay in the account view', async () => {
  for (const stage of ['revoke', 'refresh']) {
    const { store, account, calls } = setup()
    await store.getState().restore()
    if (stage === 'revoke') account.revokeDevice = async () => { throw new Error('Revoke failed') }
    else account.getDevices = async () => { throw new Error('Refresh failed') }
    await store.getState().revokeDevice(devices[1].id)
    assert.equal(store.getState().accountError, stage === 'revoke' ? 'Revoke failed' : 'Refresh failed')
    assert.equal(store.getState().phase, 'authenticated')
    assert.equal(store.getState().busyDeviceId, null)
    assert.deepEqual(store.getState().devices, devices)
    assert.equal(calls.includes('logout'), false)
  }
})

test('logout failure still clears account state and reports the sign-out warning', async () => {
  const { store, session } = setup()
  await store.getState().restore()
  session.logout = async () => { throw new Error('Offline') }
  await store.getState().logout()
  assert.equal(store.getState().phase, 'anonymous')
  assert.equal(store.getState().user, null)
  assert.deepEqual(store.getState().devices, [])
  assert.equal(store.getState().signingOut, false)
  assert.equal(store.getState().authError,
    'The server could not confirm sign-out. Reconnect and sign out again: Offline')
})

test('late restoration and account successes or failures cannot restore state after logout', async () => {
  for (const stage of ['restore', 'account']) {
    for (const fails of [false, true]) {
      const { store, session, account, calls } = setup()
      const late = deferred<never>()
      if (stage === 'restore') session.restoreSession = () => late.promise
      else account.getCurrentUser = () => late.promise
      const restoring = store.getState().restore()
      await Promise.resolve()
      await Promise.resolve()
      await store.getState().logout()
      const signedOut = store.getState()
      if (fails) late.reject(new Error('Late error'))
      else late.resolve((stage === 'restore' ? true : user) as never)
      await restoring
      assert.equal(store.getState(), signedOut)
      if (stage === 'restore') assert.equal(calls.includes('devices'), false)
    }
  }
})

test('logout cancels later registration, login, and replacement continuations', async () => {
  for (const stage of ['register', 'login', 'replace']) {
    const { store, session, identities, calls } = setup(false)
    await store.getState().restore()
    const late = deferred<never>()
    if (stage === 'register') session.register = () => late.promise
    if (stage === 'login') session.login = () => late.promise
    if (stage === 'replace') {
      session.login = async () => { throw new ClientError('Revoked', 'device_revoked') }
      identities.replace = () => late.promise
    }
    const authenticating = stage === 'register'
      ? store.getState().register('alice', ' test-password ')
      : store.getState().login('alice', ' test-password ')
    await Promise.resolve()
    await store.getState().logout()
    const signedOut = store.getState()
    late.resolve((stage === 'register' ? user : stage === 'replace' ? replacement : undefined) as never)
    await authenticating
    assert.equal(store.getState(), signedOut)
    assert.equal(calls.includes('user'), false)
    assert.equal(calls.some((call) => call.startsWith('login:')), false)
  }
})

test('old device refresh and revocation completions cannot affect a subsequent login', async () => {
  for (const stage of ['refresh', 'revoke']) {
    for (const fails of [false, true]) {
      const { store, account, calls } = setup()
      await store.getState().restore()
      const late = deferred<never>()
      const getDevices = account.getDevices
      if (stage === 'refresh') account.getDevices = () => late.promise
      else account.revokeDevice = () => late.promise
      const pending = stage === 'refresh'
        ? store.getState().refreshDevices() : store.getState().revokeDevice(identity.id)
      await store.getState().logout()
      account.getDevices = getDevices
      await store.getState().login('alice', ' test-password ')
      const signedIn = store.getState()
      if (fails) late.reject(new Error('Late error'))
      else late.resolve((stage === 'refresh' ? [] : undefined) as never)
      await pending
      assert.equal(store.getState(), signedIn)
      assert.equal(calls.filter((call) => call === 'logout').length, 1)
    }
  }
})

test('the latest device refresh wins over older results and errors', async () => {
  for (const fails of [false, true]) {
    const { store, account } = setup()
    await store.getState().restore()
    const late = deferred<Device[]>()
    account.getDevices = () => late.promise
    const first = store.getState().refreshDevices()
    account.getDevices = async () => [devices[0]]
    await store.getState().refreshDevices()
    if (fails) late.reject(new Error('Old refresh failed'))
    else late.resolve([])
    await first
    assert.deepEqual(store.getState().devices, [devices[0]])
    assert.equal(store.getState().accountError, null)
  }
})

test('expiry clears account state, invalidates pending work, and permits login again', async () => {
  const { store, account, expired } = setup()
  await store.getState().restore()
  const late = deferred<Device[]>()
  const getDevices = account.getDevices
  account.getDevices = () => late.promise
  const refresh = store.getState().refreshDevices()
  for (const handler of expired) handler()
  late.reject(new Error('Old request failed'))
  await refresh
  assert.equal(store.getState().phase, 'anonymous')
  assert.equal(store.getState().user, null)
  assert.deepEqual(store.getState().devices, [])
  assert.equal(store.getState().authError, 'Your session has ended. Please sign in again.')
  assert.equal(store.getState().accountError, null)
  account.getDevices = getDevices
  await store.getState().login('alice', ' test-password ')
  assert.equal(store.getState().phase, 'authenticated')
  assert.equal(store.getState().authError, null)
})

test('disposal unsubscribes idempotently and prevents pending identity work from restoring', async () => {
  const { store, identities, calls, expired } = setup()
  const late = deferred<DeviceIdentity>()
  identities.get = () => late.promise
  const restoring = store.getState().restore()
  assert.equal(expired.size, 1)
  const oldHandler = [...expired][0]
  store.getState().dispose()
  store.getState().dispose()
  assert.equal(expired.size, 0)
  const disposed = store.getState()
  oldHandler()
  late.resolve(identity)
  await restoring
  assert.equal(store.getState(), disposed)
  assert.deepEqual(calls, [])
  await store.getState().restore()
  assert.equal(expired.size, 1)
  assert.equal(store.getState().phase, 'authenticated')
  store.getState().dispose()
  assert.equal(expired.size, 0)
})

test('disposal during account loading ignores its eventual success or failure', async () => {
  for (const fails of [false, true]) {
    const { store, account } = setup()
    const late = deferred<CurrentUser>()
    account.getCurrentUser = () => late.promise
    const restoring = store.getState().restore()
    await Promise.resolve()
    await Promise.resolve()
    store.getState().dispose()
    const disposed = store.getState()
    if (fails) late.reject(new Error('Late error'))
    else late.resolve(user)
    await restoring
    assert.equal(store.getState(), disposed)
  }
})

test('restoration rejects an old mailbox cookie after durable device rotation', async () => {
  const { session, account, identities, calls } = setup()
  identities.get = async () => replacement
  let prepared = false
  const store = createSessionStore({ session, account, identities, prepareInbox: async () => { prepared = true } })
  await store.getState().restore()
  assert.equal(store.getState().phase, 'anonymous')
  assert.match(store.getState().authError!, /storage changed/)
  assert.equal(calls.includes('logout'), true)
  assert.equal(prepared, false)
})

test('authentication waits for durable inbox activation and fails closed on storage failure', async () => {
  const { session, account, identities } = setup()
  const activation = deferred<void>()
  const store = createSessionStore({ session, account, identities, prepareInbox: () => activation.promise })
  const restoring = store.getState().restore()
  await new Promise(done => setImmediate(done))
  assert.equal(store.getState().phase, 'restoring')
  activation.reject(new Error('Local store lost'))
  await restoring
  assert.equal(store.getState().phase, 'anonymous')
  assert.equal(store.getState().authError, 'Local store lost')
})

test('login rereads durable identity after local database loss while signed out', async () => {
  const { store, identities, account, calls } = setup(false)
  await store.getState().restore()
  identities.get = async () => replacement
  account.getCurrentUser = async () => ({ ...user, deviceId: replacement.id })
  await store.getState().login('alice', ' test-password ')
  assert.ok(calls.includes(`login:${replacement.id}`))
  assert.equal(store.getState().phase, 'authenticated')
})
