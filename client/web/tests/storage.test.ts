import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { browserDeviceDescription } from '../src/shared/platform/deviceDescription.ts'
import { browserChatPreferencesStore, browserDeviceIdentityStore } from '../src/shared/platform/storage.ts'

let dom: JSDOM
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

beforeEach(() => {
  dom = new JSDOM('', { url: 'http://localhost' })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage })
})

afterEach(() => {
  dom.window.close()
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else Reflect.deleteProperty(globalThis, 'navigator')
})

test('browser identity storage preserves the existing key and JSON format and tolerates malformed JSON', async () => {
  assert.equal(await browserDeviceIdentityStore.read(), null)
  localStorage.setItem('messenger.device', '{broken')
  assert.equal(await browserDeviceIdentityStore.read(), null)
  localStorage.setItem('messenger.device', '{"id":123}')
  assert.deepEqual(await browserDeviceIdentityStore.read(), { id: 123 })
  const identity = { id: '00000000-0000-4000-8000-000000000001', name: 'Saved browser' }
  await browserDeviceIdentityStore.write(identity)
  assert.equal(localStorage.getItem('messenger.device'), JSON.stringify(identity))
  assert.deepEqual(await browserDeviceIdentityStore.read(), identity)
})

test('browser preferences preserve per-user keys and remove only the requested preference', async () => {
  await browserChatPreferencesStore.setLastChatId('alice', 'bob-chat')
  await browserChatPreferencesStore.setLastChatId('other-user', 'carol-chat')
  assert.equal(localStorage.getItem('messenger.lastChat.alice'), 'bob-chat')
  assert.equal(localStorage.getItem('messenger.lastChat.other-user'), 'carol-chat')
  assert.equal(await browserChatPreferencesStore.getLastChatId('alice'), 'bob-chat')
  assert.equal(await browserChatPreferencesStore.getLastChatId('unknown'), null)
  await browserChatPreferencesStore.setLastChatId('alice', null)
  assert.equal(localStorage.getItem('messenger.lastChat.alice'), null)
  assert.equal(await browserChatPreferencesStore.getLastChatId('other-user'), 'carol-chat')
})

test('browser device descriptions retain browser and operating-system detection', async () => {
  for (const [userAgent, expected] of [
    ['Windows Chrome/ Safari/ Edg/', 'Windows · Edge'],
    ['Windows Firefox/', 'Windows · Firefox'],
    ['Android Linux Chrome/', 'Android · Chrome'],
    ['iPhone Mac OS Safari/', 'iOS · Safari'],
    ['iPad Mac OS Safari/', 'iOS · Safari'],
    ['Mac OS Safari/', 'macOS · Safari'],
    ['Linux Firefox/', 'Linux · Firefox'],
    ['', 'Unknown device · Browser'],
  ]) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent } })
    assert.equal(await browserDeviceDescription(), expected)
  }
})

test('storage access failures reject instead of being treated as missing data', async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('Storage unavailable') },
  })
  await assert.rejects(browserDeviceIdentityStore.read(), /Storage unavailable/)
  await assert.rejects(browserDeviceIdentityStore.write({ id: 'id', name: 'name' }), /Storage unavailable/)
  await assert.rejects(browserChatPreferencesStore.getLastChatId('alice'), /Storage unavailable/)
  await assert.rejects(browserChatPreferencesStore.setLastChatId('alice', null), /Storage unavailable/)
})
