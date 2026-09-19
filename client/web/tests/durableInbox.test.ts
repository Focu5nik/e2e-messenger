import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IndexedDBDurableInbox } from '../src/shared/platform/durableInbox.ts'

test('durable identity fails closed when IndexedDB cannot open and retries on the next call', async () => {
  let attempts = 0
  const failure = new Error('Database unavailable')
  const indexedDB = {
    open() {
      attempts += 1
      const opening = { error: failure, onerror: null as (() => void) | null }
      queueMicrotask(() => opening.onerror?.())
      return opening
    },
  } as unknown as IDBFactory
  const inbox = new IndexedDBDurableInbox({ indexedDB })
  assert.equal(attempts, 0, 'constructing the adapter must not access storage')
  await assert.rejects(inbox.read(), failure)
  await assert.rejects(inbox.read(), failure)
  assert.equal(attempts, 2)
})

test('failed durable identity writes do not access or reuse legacy localStorage identity', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  let legacyAccesses = 0
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { legacyAccesses += 1; throw new Error('Legacy storage must not be consulted') },
  })
  try {
    const inbox = new IndexedDBDurableInbox({
      indexedDB: { open() { throw new Error('IndexedDB disabled') } } as unknown as IDBFactory,
    })
    await assert.rejects(inbox.read(), /IndexedDB disabled/)
    await assert.rejects(inbox.write({ id: 'new-device', name: 'Browser' }), /IndexedDB disabled/)
    assert.equal(legacyAccesses, 0)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
