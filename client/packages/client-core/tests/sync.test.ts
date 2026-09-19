import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ClientError, MessengerService, SyncManager,
  type CurrentUser, type DurableInbox, type InboxSnapshot, type MailboxEnvelope,
  type MailboxPage, type MessagingGateway, type RealtimeGateway, type SendMessageRequest,
} from '../src/index.ts'

const user: CurrentUser = { id: 'bob', deviceId: 'device', sessionId: 'session', username: 'bob', status: 'active', createdAt: '2026-09-17T00:00:00Z' }
const envelope = (seq: number): MailboxEnvelope => ({
  id: `envelope-${seq}`, message_id: `message-${seq}`, chat_id: 'chat',
  sender_user_id: 'alice', sender_device_id: 'alice-device', client_message_id: `client-${seq}`,
  recipient_device_id: 'device', mailbox_seq: seq, protocol_version: 0, envelope_type: 'PLAINTEXT',
  payload: 'opaque', created_at: user.createdAt, message_created_at: user.createdAt,
  expires_at: '2026-11-01T00:00:00Z', delivered_at: null, payload_purged_at: null,
})

function setup() {
  let state: InboxSnapshot = { cursor: 0, envelopes: [], outgoing: [], chats: [] }
  const commits: number[] = []
  const inbox: DurableInbox = {
    async read() { return { id: 'device', name: 'Browser', generation: 'generation' } },
    async write() {},
    async snapshot() { return structuredClone(state) },
    async commitPage(_scope, expected, envelopes, next) {
      assert.equal(state.cursor, expected)
      commits.push(next)
      const records = new Map(state.envelopes.map(item => [item.id, item]))
      for (const item of envelopes) records.set(item.id, item)
      state = { ...state, cursor: next, envelopes: [...records.values()] }
    },
    async putOutgoing(_scope, command) { state.outgoing.push({ command: structuredClone(command), accepted: null }) },
    async rejectOutgoing(_scope, id) { state.outgoing = state.outgoing.filter(item => item.command.client_message_id !== id) },
    async acceptOutgoing(_scope, accepted) { state.outgoing.find(item => item.command.client_message_id === accepted.clientMessageId)!.accepted = accepted },
    async saveChats(_scope, chats) { state.chats = chats },
  }
  const requested: number[] = []
  let available: MailboxEnvelope[] = []
  const api: MessagingGateway = {
    async getMailbox(after) {
      requested.push(after)
      const envelopes = available.filter(item => item.mailbox_seq > after).slice(0, 3)
      const nextSeq = envelopes.at(-1)?.mailbox_seq ?? after
      return { envelopes, nextSeq, hasMore: available.some(item => item.mailbox_seq > nextSeq) }
    },
    async getDestinationDevices() { return [{ id: 'alice-device', protocolVersion: 0 }] },
    async sendMessage(command) {
      return { id: 'accepted', chatId: command.chat_id, clientMessageId: command.client_message_id,
        senderUserId: user.id, senderDeviceId: user.deviceId, createdAt: user.createdAt, envelopes: [] }
    },
  }
  const manager = new SyncManager(inbox, api)
  return { manager, inbox, api, commits, requested, available: (envelopes: MailboxEnvelope[]) => { available = envelopes } }
}

test('offline 5 then 3 pages resume only from durable cursor and reload without duplicates', async () => {
  const { manager, inbox, api, requested, available } = setup()
  await manager.activate(user)
  available(Array.from({ length: 5 }, (_, n) => envelope(n + 1)))
  assert.equal((await manager.synchronize()).envelopes.length, 5)
  const restored = new SyncManager(inbox, api)
  await restored.activate(user)
  available(Array.from({ length: 8 }, (_, n) => envelope(n + 1)))
  assert.equal((await restored.synchronize()).envelopes.length, 8)
  assert.deepEqual(requested, [0, 3, 5])
  await restored.ingest(envelope(8))
  assert.equal((await restored.snapshot()).envelopes.length, 8)
})

test('tombstones retain complete metadata and advance the atomic page cursor', async () => {
  const { manager, available, commits } = setup()
  await manager.activate(user)
  const tombstone = { ...envelope(2), payload: null, payload_purged_at: user.createdAt }
  available([envelope(1), tombstone, envelope(3)])
  const state = await manager.synchronize()
  assert.deepEqual(state.envelopes[1], tombstone)
  assert.deepEqual(commits, [3])
})

test('failed local commit leaves cursor unchanged and the next sync retries the page', async () => {
  const { manager, inbox, available, requested } = setup()
  await manager.activate(user)
  available([envelope(1)])
  const commit = inbox.commitPage
  inbox.commitPage = async () => { throw new Error('Transaction aborted') }
  await assert.rejects(manager.synchronize(), /aborted/)
  assert.equal((await manager.snapshot()).cursor, 0)
  inbox.commitPage = commit
  assert.equal((await manager.synchronize()).cursor, 1)
  assert.deepEqual(requested, [0, 0])
})

test('gaps, wrong devices and inconsistent final cursors stop before committing', async () => {
  const pages: MailboxPage[] = [
    { envelopes: [envelope(2)], nextSeq: 2, hasMore: false },
    { envelopes: [{ ...envelope(1), recipient_device_id: 'other' }], nextSeq: 1, hasMore: false },
    { envelopes: [envelope(1)], nextSeq: 2, hasMore: false },
    { envelopes: [], nextSeq: 0, hasMore: true },
  ]
  for (const page of pages) {
    const { manager, api, commits } = setup()
    await manager.activate(user)
    api.getMailbox = async () => page
    await assert.rejects(manager.synchronize(), /sync stopped/)
    assert.deepEqual(commits, [])
  }
})

test('out-of-order realtime catches up through mailbox tombstones before advancing', async () => {
  const { manager, available, requested } = setup()
  await manager.activate(user)
  available([envelope(1), { ...envelope(2), payload: null }, envelope(3)])
  const state = await manager.ingest(envelope(3))
  assert.equal(state.cursor, 3)
  assert.equal(state.envelopes.length, 3)
  assert.deepEqual(requested, [0])
})

test('session replacement discards a late page and failed activation clears the old scope', async () => {
  const { manager, api, inbox, commits } = setup()
  await manager.activate(user)
  let resolve!: (page: MailboxPage) => void
  api.getMailbox = () => new Promise(done => { resolve = done })
  const syncing = manager.synchronize()
  await new Promise(done => setImmediate(done))
  manager.deactivate()
  resolve({ envelopes: [envelope(1)], nextSeq: 1, hasMore: false })
  await assert.rejects(syncing, /session changed/)
  assert.deepEqual(commits, [])
  await manager.activate(user)
  inbox.read = async () => null
  await assert.rejects(manager.activate(user), /reset/)
  assert.throws(() => manager.scope(), /not ready/)
})

test('authenticated realtime sync is preferred and malformed live sequences cannot commit', async () => {
  const { inbox, api, commits } = setup()
  api.getMailbox = async () => { throw new Error('Unexpected HTTP') }
  const realtime: RealtimeGateway = {
    ready: true, start() {}, stop() {}, onMessage: () => () => {}, onReady: () => () => {},
    sendMessage: api.sendMessage,
    async getMailbox() { return { envelopes: [envelope(1)], nextSeq: 1, hasMore: false } },
  }
  const manager = new SyncManager(inbox, api, realtime)
  await manager.activate(user)
  assert.equal((await manager.synchronize()).cursor, 1)
  for (const invalid of [0, -1, 1.5, NaN]) await assert.rejects(manager.ingest(envelope(invalid)), /sequence/)
  assert.deepEqual(commits, [1])
})

test('outgoing commands commit before send, accepted messages restore, and failed writes prevent transmission', async () => {
  const { manager, api, inbox } = setup()
  await manager.activate(user)
  const send = api.sendMessage
  api.sendMessage = async command => {
    assert.deepEqual((await manager.snapshot()).outgoing[0].command, command)
    return send(command)
  }
  const codec = {
    async buildOutgoing() { return [{ recipient_device_id: 'alice-device', protocol_version: 0, envelope_type: 'OPAQUE', payload: 'exact-bytes' }] },
    async decodeIncoming() { return 'decoded only in memory' },
  }
  const messenger = new MessengerService(api, codec, () => 'client-id', undefined, manager)
  await messenger.sendText('chat', 'private content')
  assert.equal((await messenger.restoreLocal()).messages[0].content, 'decoded only in memory')
  assert.doesNotMatch(JSON.stringify(await manager.snapshot()), /private content|decoded only/)
  inbox.putOutgoing = async () => { throw new Error('Quota exceeded') }
  api.sendMessage = async () => { throw new Error('Unexpected transmission') }
  await assert.rejects(messenger.sendText('chat', 'next'), /Quota/)
})

test('ambiguous sends retain original command bytes and never automatically replay over HTTP', async () => {
  const { manager, inbox, api } = setup()
  await manager.activate(user)
  api.sendMessage = async () => { throw new Error('Unexpected HTTP replay') }
  let attempted: SendMessageRequest | undefined
  const realtime: RealtimeGateway = {
    ready: true, start() {}, stop() {}, onMessage: () => () => {}, onReady: () => () => {},
    async sendMessage(command) { attempted = structuredClone(command); throw new ClientError('Unconfirmed', 'delivery_unconfirmed') },
  }
  const messenger = new MessengerService(api, {
    async buildOutgoing() { return [{ recipient_device_id: 'alice-device', protocol_version: 0, envelope_type: 'OPAQUE', payload: 'immutable' }] },
    async decodeIncoming() { return 'unused' },
  }, () => 'stable-id', realtime, manager)
  await assert.rejects(messenger.sendText('chat', 'private'), /Unconfirmed/)
  assert.deepEqual((await inbox.snapshot(manager.scope())).outgoing, [{ command: attempted, accepted: null }])
})
