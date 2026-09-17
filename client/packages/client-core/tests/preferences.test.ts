import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ChatPreferencesService, DeviceIdentityService, isDeviceIdentity,
  type ChatPreferencesStore, type DeviceIdentity, type DeviceIdentityStore, type DirectChat,
} from '../src/index.ts'

const identity: DeviceIdentity = { id: '00000000-0000-4000-8000-000000000001', name: 'Saved device' }
const replacement: DeviceIdentity = { id: '00000000-0000-4000-8000-000000000002', name: 'New device' }

function identitySetup(initial: unknown) {
  let stored = initial
  const writes: DeviceIdentity[] = []
  const store: DeviceIdentityStore = {
    async read() { return stored },
    async write(value) { writes.push(value); stored = value },
  }
  const service = new DeviceIdentityService(store, () => replacement.id, async () => replacement.name)
  return { service, store, writes }
}

test('identity restoration preserves valid stored IDs and names without writing', async () => {
  for (const value of [identity, { ...identity, name: ' a ' }, { ...identity, name: 'a'.repeat(100) },
    { ...identity, id: 'ABCDEFAB-1234-8123-ABCD-ABCDEFABCDEF' }]) {
    const { service, writes } = identitySetup(value)
    assert.equal(isDeviceIdentity(value), true)
    assert.deepEqual(await service.get(), value)
    assert.deepEqual(writes, [])
  }
})

test('missing and malformed identities are replaced once and restored on subsequent reads', async () => {
  for (const value of [null, undefined, [], 'invalid', {}, { ...identity, id: 'invalid' },
    { ...identity, id: '00000000-0000-0000-0000-000000000000' }, { ...identity, id: 123 },
    { ...identity, name: null }, { ...identity, name: '' }, { ...identity, name: '   ' },
    { ...identity, name: 'a'.repeat(101) }]) {
    const { service, writes } = identitySetup(value)
    assert.equal(isDeviceIdentity(value), false)
    assert.deepEqual(await service.get(), replacement)
    assert.deepEqual(await service.get(), replacement)
    assert.deepEqual(writes, [replacement])
  }
})

test('concurrent identity restoration creates one stable persisted identity', async () => {
  const { service, writes } = identitySetup(null)
  const results = await Promise.all(Array.from({ length: 5 }, () => service.get()))
  assert.deepEqual(results, Array.from({ length: 5 }, () => replacement))
  assert.deepEqual(writes, [replacement])
})

test('explicit replacement persists a new identity before later restoration can reuse it', async () => {
  const { service, writes } = identitySetup(identity)
  const results = await Promise.all([service.get(), service.replace(), service.get()])
  assert.deepEqual(results, [identity, replacement, replacement])
  assert.deepEqual(writes, [replacement])
})

test('storage failures reject identity operations without poisoning later attempts', async () => {
  const { service, store, writes } = identitySetup(null)
  const read = store.read
  store.read = async () => { throw new Error('Read failed') }
  await assert.rejects(service.get(), /Read failed/)
  assert.deepEqual(writes, [])
  store.read = read
  const write = store.write
  store.write = async () => { throw new Error('Write failed') }
  await assert.rejects(service.get(), /Write failed/)
  store.write = write
  assert.deepEqual(await service.get(), replacement)
})

const chats: DirectChat[] = ['bob', 'carol'].map((id) => ({
  id, type: 'DIRECT', createdAt: '2026-09-13T00:00:00Z',
  otherUser: { id, username: id, status: 'active', createdAt: '2026-09-13T00:00:00Z' },
}))

function preferencesSetup() {
  const values = new Map<string, string>()
  const store: ChatPreferencesStore = {
    async getLastChatId(userId) { return values.get(userId) ?? null },
    async setLastChatId(userId, chatId) {
      if (chatId === null) values.delete(userId)
      else values.set(userId, chatId)
    },
  }
  return { values, store, service: new ChatPreferencesService(store) }
}

test('last-chat policy restores only available chats and clears missing chats for the current user', async () => {
  const { service, values } = preferencesSetup()
  await service.select('alice', 'bob')
  await service.select('other-user', 'carol')
  assert.deepEqual(await service.restore('alice', chats), chats[0])
  assert.equal(await service.restore('new-user', chats), null)
  assert.equal(await service.restore('alice', [chats[1]]), null)
  assert.equal(values.has('alice'), false)
  assert.equal(values.get('other-user'), 'carol')
  await service.select('other-user', null)
  assert.equal(values.size, 0)
})

test('delayed missing-chat cleanup cannot overwrite a newer selection', async () => {
  const { service, store, values } = preferencesSetup()
  let resolveRead!: (value: string) => void
  store.getLastChatId = () => new Promise((resolve) => { resolveRead = resolve })
  const restoring = service.restore('alice', chats)
  await Promise.resolve()
  const selecting = service.select('alice', 'carol')
  resolveRead('deleted-chat')
  assert.equal(await restoring, null)
  await selecting
  assert.equal(values.get('alice'), 'carol')
})

test('asynchronous preference writes remain ordered and recover after failure', async () => {
  const { service, store, values } = preferencesSetup()
  const write = store.setLastChatId
  let release!: () => void
  store.setLastChatId = async (userId, chatId) => {
    if (chatId === 'bob') await new Promise<void>((resolve) => { release = resolve })
    if (chatId === 'failed') throw new Error('Write failed')
    await write(userId, chatId)
  }
  const first = service.select('alice', 'bob')
  const second = service.select('alice', 'carol')
  await Promise.resolve()
  assert.equal(values.size, 0)
  release()
  await Promise.all([first, second])
  assert.equal(values.get('alice'), 'carol')
  await assert.rejects(service.select('alice', 'failed'), /Write failed/)
  await service.select('alice', null)
  assert.equal(values.has('alice'), false)
})
