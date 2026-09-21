import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ClientError, MessengerService, SyncManager,
  type CurrentUser, type DisplayMessage, type DurableInbox, type InboxSnapshot, type MailboxEnvelope,
  type MailboxPage, type MessagingGateway, type OutgoingCommand, type RealtimeGateway, type SendMessageRequest,
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
  const receipts = new Map<string, MailboxEnvelope>()
  const commits: number[] = []
  const inbox: DurableInbox = {
    async read() { return { id: 'device', name: 'Browser', generation: 'generation' } },
    async write() {},
    async snapshot() { return structuredClone(state) },
    async readMetadata() { return { cursor: state.cursor, chats: state.chats } },
    async readCursor() { return state.cursor },
    async getPendingAcknowledgments() { return structuredClone(state.envelopes.filter(item => item.payload !== null && !item.delivered_at)) },
    async getOutgoingToRecover() { return structuredClone(state.outgoing.filter(item => !item.accepted?.envelopes.length || item.accepted.envelopes.some(envelope => !envelope.delivered_at))) },
    async readChatHistory() { throw new Error('Not used') },
    async applyDeliveryReceipt(_scope, receipt) {
      const outgoing = state.outgoing.find(item => item.accepted?.id === receipt.message_id)
      if (!outgoing?.accepted) { receipts.set(receipt.id, receipt as MailboxEnvelope); return null }
      const envelope = outgoing.accepted.envelopes.find(item => item.id === receipt.id && item.recipient_device_id === receipt.recipient_device_id)
      if (!envelope || envelope.delivered_at === receipt.delivered_at) return null
      envelope.delivered_at = receipt.delivered_at
      envelope.payload_purged_at = receipt.payload_purged_at
      return structuredClone(outgoing)
    },
    async getOutgoing(_scope, id) { return structuredClone(state.outgoing.find(item => item.command.client_message_id === id) ?? null) },
    async commitPage(_scope, expected, envelopes, next) {
      assert.equal(state.cursor, expected)
      commits.push(next)
      const records = new Map(state.envelopes.map(item => [item.id, item]))
      const changes: MailboxEnvelope[] = []
      for (const item of envelopes) {
        const prior = records.get(item.id)
        const merged = { ...item, payload: item.payload ?? prior?.payload ?? null, delivered_at: item.delivered_at ?? prior?.delivered_at ?? null,
          payload_purged_at: item.payload_purged_at ?? prior?.payload_purged_at ?? null }
        if (JSON.stringify(prior) !== JSON.stringify(merged)) changes.push(merged)
        records.set(item.id, merged)
      }
      state = { ...state, cursor: next, envelopes: [...records.values()] }
      return changes
    },
    async putOutgoing(_scope, command, replaceRejected) {
      const existing = state.outgoing.find(item => item.command.client_message_id === command.client_message_id)
      if (existing) {
        if (!replaceRejected) { assert.deepEqual(existing.command, command); return structuredClone(existing) }
        assert.equal(existing.accepted, null)
        existing.command = structuredClone(command)
      } else state.outgoing.push({ command: structuredClone(command), accepted: null })
      return structuredClone(state.outgoing.find(item => item.command.client_message_id === command.client_message_id)!)
    },
    async rejectOutgoing(_scope, id) { state.outgoing = state.outgoing.filter(item => item.command.client_message_id !== id) },
    async acceptOutgoing(_scope, accepted) {
      const outgoing = state.outgoing.find(item => item.command.client_message_id === accepted.clientMessageId)!
      outgoing.accepted = structuredClone(accepted)
      for (const envelope of outgoing.accepted.envelopes) {
        const receipt = receipts.get(envelope.id)
        if (receipt) { envelope.delivered_at = receipt.delivered_at; receipts.delete(envelope.id) }
      }
      return structuredClone(outgoing)
    },
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
  assert.equal((await restored.synchronize()).envelopes.length, 3)
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


test('V6 ACK waits for durable commit and retries after crash without losing the local payload', async () => {
  for (const delivery of ['sync', 'realtime'] as const) {
    const { manager, inbox, api, available } = setup()
    await manager.activate(user)
    available([envelope(1)])
    let acknowledgments = 0
    let loseResponse = true
    api.acknowledgeEnvelope = async id => {
      acknowledgments += 1
      const state = await manager.snapshot()
      assert.equal(state.cursor, 1)
      assert.equal(state.envelopes[0].id, id)
      assert.equal(state.envelopes[0].payload, 'opaque')
      if (loseResponse) throw new Error('ACK response lost')
      return { ...envelope(1), payload: null, delivered_at: user.createdAt, payload_purged_at: user.createdAt }
    }
    const commit = inbox.commitPage
    inbox.commitPage = async () => { throw new Error('Before local commit') }
    const deliver = () => delivery === 'sync' ? manager.synchronize() : manager.ingest(envelope(1))
    await assert.rejects(deliver(), /Before local commit/)
    assert.equal(acknowledgments, 0)
    inbox.commitPage = commit
    assert.equal((await deliver()).envelopes.length, 1)
    assert.equal(acknowledgments, 1)
    assert.equal((await manager.snapshot()).cursor, 1)
    // Simulated restart cannot rely on the cursor alone: the pending ACK is local.
    const restarted = new SyncManager(inbox, api)
    await restarted.activate(user)
    loseResponse = false
    const restored = await restarted.synchronize()
    assert.equal(acknowledgments, 2)
    assert.equal(restored.envelopes.length, 1)
    assert.equal(restored.envelopes[0].payload, 'opaque')
    assert.equal(restored.envelopes[0].delivered_at, user.createdAt)
    await restarted.synchronize()
    assert.equal(acknowledgments, 2)
  }
})

test('V6 recovery looks up the original ID and only resends exact durable bytes after confirmed absence', async () => {
  for (const committed of [false, true]) {
    const { manager, api } = setup()
    await manager.activate(user)
    const command: SendMessageRequest = { chat_id: 'chat', client_message_id: 'original-id', envelopes: [{
      recipient_device_id: 'alice-device', protocol_version: 0, envelope_type: 'OPAQUE', payload: 'immutable-original-bytes',
    }] }
    await manager.inbox.putOutgoing(manager.scope(), command)
    const accepted = await api.sendMessage(command)
    let sends = 0
    let lookedUp = false
    api.findSentMessage = async id => {
      assert.equal(id, command.client_message_id)
      lookedUp = true
      return committed ? accepted : null
    }
    api.sendMessage = async original => {
      assert.equal(lookedUp, true)
      assert.deepEqual(original, command)
      sends += 1
      return accepted
    }
    const messenger = new MessengerService(api, {
      async buildOutgoing() { throw new Error('Recovery must not re-encode') },
      async decodeIncoming() { return 'decoded in memory' },
    }, () => { throw new Error('Recovery must not generate an ID') }, undefined, manager)
    assert.equal((await messenger.restoreLocal()).messages[0].status, 'pending')
    await messenger.sendText('chat', 'must not rebuild this text', 'original-id')
    assert.equal(sends, committed ? 0 : 1)
    assert.equal((await manager.snapshot()).outgoing.length, 1)
    assert.deepEqual((await manager.snapshot()).outgoing[0].command, command)
    assert.equal((await messenger.restoreLocal()).messages[0].status, 'accepted')
  }
})

test('V6 recovery never sends when the acceptance lookup itself is ambiguous', async () => {
  const { manager, api } = setup()
  await manager.activate(user)
  await manager.inbox.putOutgoing(manager.scope(), { chat_id: 'chat', client_message_id: 'original', envelopes: [{
    recipient_device_id: 'alice-device', protocol_version: 0, envelope_type: 'OPAQUE', payload: 'opaque',
  }] })
  api.findSentMessage = async () => { throw new Error('Lookup disconnected') }
  api.sendMessage = async () => { throw new Error('Blind HTTP replay') }
  const messenger = new MessengerService(api, {
    async buildOutgoing() { throw new Error('Unexpected re-encoding') }, async decodeIncoming() { return 'private' },
  }, () => 'new-id', undefined, manager)
  await assert.rejects(messenger.retryOutgoing('original'), /Lookup disconnected/)
  assert.equal((await manager.snapshot()).outgoing[0].accepted, null)
})

test('V6 outgoing pending state is emitted before transmission and converges through delivery receipt', async () => {
  const { manager, api } = setup()
  await manager.activate(user)
  const states: string[] = []
  let receiptHandler: ((envelope: MailboxEnvelope) => void) | undefined
  const destination = { ...envelope(1), recipient_device_id: 'alice-device', message_id: 'accepted' }
  const accepted = { ...await api.sendMessage({ chat_id: 'chat', client_message_id: 'client-id', envelopes: [] }), envelopes: [destination] }
  api.findSentMessage = async () => ({ ...accepted, envelopes: [{ ...destination, payload: null, delivered_at: user.createdAt, payload_purged_at: user.createdAt }] })
  const realtime: RealtimeGateway = {
    ready: true, start() {}, stop() {}, onMessage: () => () => {}, onReady: () => () => {},
    onDelivered(handler) { receiptHandler = handler; return () => { receiptHandler = undefined } },
    async sendMessage() { assert.deepEqual(states, ['pending']); return accepted },
  }
  const messenger = new MessengerService(api, {
    async buildOutgoing() { return [{ recipient_device_id: 'alice-device', protocol_version: 0, envelope_type: 'OPAQUE', payload: 'original' }] },
    async decodeIncoming() { return 'private' },
  }, () => 'client-id', realtime, manager)
  messenger.onOutgoing(messages => states.push(...messages.map(message => message.status!)))
  messenger.onDelivery(update => states.push(update.status!))
  const unsubscribe = messenger.subscribe(() => {}, error => { throw error })
  await messenger.sendText('chat', 'private')
  assert.deepEqual(states, ['pending', 'accepted'])
  receiptHandler!({ ...destination, payload: null, delivered_at: user.createdAt, payload_purged_at: user.createdAt })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(states, ['pending', 'accepted', 'delivered'])
  assert.equal((await manager.snapshot()).outgoing.length, 1)
  unsubscribe()
})


test('V6 receipt arriving during the acceptance transaction converges without reconnect', async () => {
  const { manager, api, inbox } = setup()
  await manager.activate(user)
  const destination = { ...envelope(1), recipient_device_id: 'alice-device', message_id: 'accepted' }
  const accepted = { ...await api.sendMessage({ chat_id: 'chat', client_message_id: 'race-id', envelopes: [] }), envelopes: [destination] }
  const receipt = { ...destination, payload: null, delivered_at: user.createdAt, payload_purged_at: user.createdAt }
  let onDelivered!: (envelope: typeof receipt) => void
  const realtime: RealtimeGateway = {
    ready: true, start() {}, stop() {}, onMessage: () => () => {}, onReady: () => () => {},
    onDelivered(handler) { onDelivered = handler; return () => {} },
    async sendMessage() { return accepted },
  }
  api.findSentMessage = async () => ({ ...accepted, envelopes: [receipt] })
  const accept = inbox.acceptOutgoing
  let first = true
  inbox.acceptOutgoing = async (scope, message) => {
    if (first) {
      first = false
      onDelivered(receipt)
      await new Promise(resolve => setImmediate(resolve))
    }
    return accept(scope, message)
  }
  const messenger = new MessengerService(api, {
    async buildOutgoing() { return [{ recipient_device_id: 'alice-device', protocol_version: 0, envelope_type: 'OPAQUE', payload: 'original' }] },
    async decodeIncoming() { return 'private' },
  }, () => 'race-id', realtime, manager)
  messenger.subscribe(() => {}, error => { throw error })
  await messenger.sendText('chat', 'private')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await messenger.restoreLocal()).messages[0].status, 'delivered')
})

test('V6 retry cannot replay an old snapshot under a replaced session', async () => {
  for (const retry of ['explicit', 'send'] as const) {
    const { manager, api, inbox } = setup()
    await manager.activate(user)
    await inbox.putOutgoing(manager.scope(), { chat_id: 'chat', client_message_id: 'old-id', envelopes: [{
      recipient_device_id: 'alice-device', protocol_version: 0, envelope_type: 'OPAQUE', payload: 'old-bytes',
    }] })
    let release!: (outgoing: OutgoingCommand | null) => void
    const original = await inbox.getOutgoing(manager.scope(), 'old-id')
    inbox.getOutgoing = () => new Promise(resolve => { release = resolve })
    api.findSentMessage = async () => { throw new Error('Must not query another session') }
    const messenger = new MessengerService(api, {
      async buildOutgoing() { throw new Error('Must not rebuild') }, async decodeIncoming() { return 'private' },
    }, () => 'unused', undefined, manager)
    const pending = retry === 'explicit' ? messenger.retryOutgoing('old-id') : messenger.sendText('chat', 'private', 'old-id')
    await manager.activate(user)
    release(original)
    await assert.rejects(pending, /session changed/)
  }
})

test('V6 explicit target rejection retains a durable pending record if fresh targets are unavailable', async () => {
  const { manager, api } = setup()
  await manager.activate(user)
  let discovery = 0
  api.getDestinationDevices = async () => ++discovery === 1 ? [{ id: 'alice-device', protocolVersion: 0 }] : []
  api.sendMessage = async () => { throw new ClientError('Targets changed', 'delivery_targets_changed') }
  const messenger = new MessengerService(api, {
    async buildOutgoing() { return [{ recipient_device_id: 'alice-device', protocol_version: 0, envelope_type: 'OPAQUE', payload: 'original' }] },
    async decodeIncoming() { return 'private' },
  }, () => 'rejected-id', undefined, manager)
  await assert.rejects(messenger.sendText('chat', 'private'), /no available devices/)
  assert.equal((await manager.snapshot()).outgoing.length, 1)
  assert.equal((await manager.snapshot()).outgoing[0].command.client_message_id, 'rejected-id')
  assert.equal((await messenger.restoreLocal()).messages[0].status, 'pending')
})

test('V6 one failed outgoing recovery does not hide the inbox or block other accepted commands', async () => {
  const { manager, api, available } = setup()
  await manager.activate(user)
  available([envelope(1)])
  for (const id of ['failed', 'confirmed']) await manager.inbox.putOutgoing(manager.scope(), {
    chat_id: 'chat', client_message_id: id, envelopes: [{ recipient_device_id: 'alice-device', protocol_version: 0, envelope_type: 'OPAQUE', payload: 'opaque' }],
  })
  api.findSentMessage = async id => {
    if (id === 'failed') throw new Error('Connection lost')
    return { id: 'accepted', chatId: 'chat', senderUserId: user.id, senderDeviceId: user.deviceId,
      clientMessageId: id, createdAt: user.createdAt, envelopes: [] }
  }
  const messenger = new MessengerService(api, {
    async buildOutgoing() { throw new Error('Unexpected build') }, async decodeIncoming() { return 'private' },
  }, () => 'unused', undefined, manager)
  const loaded = await messenger.loadMailbox()
  assert.equal(loaded.messages.length, 1)
  const restored = await messenger.restoreLocal()
  assert.equal(restored.messages.find(item => item.clientMessageId === 'failed')?.status, 'pending')
  assert.equal(restored.messages.find(item => item.clientMessageId === 'confirmed')?.status, 'accepted')
})

test('100 recoveries among 1000 outgoing rows publish one delta batch without per-command snapshots', async () => {
  const { manager, api, inbox } = setup()
  await manager.activate(user)
  const accepted = new Map<string, Awaited<ReturnType<typeof api.sendMessage>>>()
  for (let index = 0; index < 1000; index += 1) {
    const command: SendMessageRequest = { chat_id: `chat-${index % 10}`, client_message_id: `client-${index}`, envelopes: [{
      recipient_device_id: 'alice-device', protocol_version: 0, envelope_type: 'OPAQUE', payload: `opaque-${index}`,
    }] }
    await inbox.putOutgoing(manager.scope(), command)
    const sent = { ...await api.sendMessage(command), id: `accepted-${index}`, envelopes: [{
      ...envelope(index + 1), recipient_device_id: 'alice-device', delivered_at: index < 100 ? null : user.createdAt,
    }] }
    accepted.set(command.client_message_id, sent)
    if (index >= 100) await inbox.acceptOutgoing(manager.scope(), sent)
  }
  let lookups = 0
  api.findSentMessage = async id => { lookups += 1; return accepted.get(id)! }
  let snapshots = 0
  const snapshot = inbox.snapshot
  inbox.snapshot = async scope => { snapshots += 1; return snapshot(scope) }
  let decodes = 0
  const messenger = new MessengerService(api, {
    async buildOutgoing() { throw new Error('Unexpected build') },
    async decodeIncoming() { decodes += 1; return 'private' },
  }, () => 'unused', undefined, manager)
  const batches: DisplayMessage[][] = []
  messenger.onOutgoing(messages => batches.push(messages))
  assert.equal((await messenger.loadMailbox()).messages.length, 0)
  assert.equal(lookups, 100)
  assert.equal(decodes, 100, 'Only changed outgoing rows are decoded')
  assert.equal(snapshots, 0)
  assert.deepEqual(batches.map(messages => messages.length), [100])
  assert.equal(new Set(batches[0].map(message => message.clientMessageId)).size, 100)
  await messenger.loadMailbox()
  assert.equal(batches.length, 1, 'Unchanged recovery results must not notify subscribers')
  assert.equal(decodes, 100, 'Unchanged outgoing rows are never decoded again')
})

test('send and explicit retry publish only their command without reading the entire inbox', async () => {
  const { manager, api, inbox } = setup()
  await manager.activate(user)
  inbox.snapshot = async () => { throw new Error('Unexpected full snapshot') }
  api.findSentMessage = async id => ({
    id: 'accepted', chatId: 'chat', clientMessageId: id, senderUserId: user.id,
    senderDeviceId: user.deviceId, createdAt: user.createdAt, envelopes: [],
  })
  let decodes = 0
  const messenger = new MessengerService(api, {
    async buildOutgoing() { return [{ recipient_device_id: 'alice-device', protocol_version: 0, envelope_type: 'OPAQUE', payload: 'opaque' }] },
    async decodeIncoming() { decodes += 1; return 'private' },
  }, () => 'one-id', undefined, manager)
  const batches: DisplayMessage[][] = []
  messenger.onOutgoing(messages => batches.push(messages))
  await messenger.sendText('chat', 'private')
  await messenger.retryOutgoing('one-id')
  assert.equal(decodes, 2)
  assert.deepEqual(batches.map(messages => messages.map(message => message.status)), [['pending'], ['accepted']])
})

test('concurrent mailbox loads join an active outgoing recovery instead of repeating lookups', async () => {
  const { manager, api } = setup()
  await manager.activate(user)
  const command: SendMessageRequest = { chat_id: 'chat', client_message_id: 'one-id', envelopes: [{
    recipient_device_id: 'alice-device', protocol_version: 0, envelope_type: 'OPAQUE', payload: 'opaque',
  }] }
  await manager.inbox.putOutgoing(manager.scope(), command)
  const accepted = await api.sendMessage(command)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let lookups = 0
  api.findSentMessage = async () => { lookups += 1; await pending; return accepted }
  const messenger = new MessengerService(api, {
    async buildOutgoing() { throw new Error('Unexpected build') }, async decodeIncoming() { return 'private' },
  }, () => 'unused', undefined, manager)
  const first = messenger.loadMailbox()
  await new Promise(resolve => setImmediate(resolve))
  const second = messenger.loadMailbox()
  await new Promise(resolve => setImmediate(resolve))
  release()
  await Promise.all([first, second])
  assert.equal(lookups, 1)
})


test('realtime ingestion decodes one delta batch including gap fills and ignores duplicate envelopes', async () => {
  const { manager, inbox, api, available } = setup()
  await manager.activate(user)
  available(Array.from({ length: 1000 }, (_, index) => envelope(index + 1)))
  await manager.synchronize()
  inbox.snapshot = async () => { throw new Error('Unexpected full snapshot') }
  let receive!: (value: MailboxEnvelope) => void
  const realtime: RealtimeGateway = {
    ready: true, start() {}, stop() {}, onReady: () => () => {}, sendMessage: api.sendMessage,
    onMessage(handler) { receive = handler; return () => {} },
  }
  let decodes = 0
  const messenger = new MessengerService(api, {
    async buildOutgoing() { throw new Error('Unexpected send') },
    async decodeIncoming() { decodes += 1; return 'private' },
  }, () => 'unused', realtime, manager)
  const batches: number[][] = []
  messenger.subscribe(messages => batches.push(messages.map(item => item.mailboxSeq)), error => { throw error })
  available([envelope(1001), envelope(1002), envelope(1003)])
  receive(envelope(1003))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(batches, [[1001, 1002, 1003]])
  assert.equal(decodes, 3)
  receive(envelope(1003))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(batches.length, 1)
  assert.equal(decodes, 3)
  assert.deepEqual((await manager.synchronize()).envelopes, [])
})

test('a receipt racing acceptance publication updates only delivery metadata after the message is published', async () => {
  const { manager, inbox, api } = setup()
  await manager.activate(user)
  inbox.snapshot = async () => { throw new Error('Unexpected full snapshot') }
  api.findSentMessage = async () => { throw new Error('Receipt must not perform a server lookup') }
  const destination = { ...envelope(1), recipient_device_id: 'alice-device', message_id: 'accepted' }
  const accepted = { ...await api.sendMessage({ chat_id: 'chat', client_message_id: 'race-id', envelopes: [] }), envelopes: [destination] }
  let delivered!: (value: MailboxEnvelope) => void
  const realtime: RealtimeGateway = {
    ready: true, start() {}, stop() {}, onMessage: () => () => {}, onReady: () => () => {},
    onDelivered(handler) { delivered = handler; return () => {} },
    async sendMessage() { return accepted },
  }
  let decodes = 0
  const messenger = new MessengerService(api, {
    async buildOutgoing() { return [{ recipient_device_id: 'alice-device', protocol_version: 0, envelope_type: 'OPAQUE', payload: 'original' }] },
    async decodeIncoming() {
      if (++decodes === 2) {
        delivered({ ...destination, payload: null, delivered_at: user.createdAt })
        await new Promise(resolve => setImmediate(resolve))
      }
      return 'private'
    },
  }, () => 'race-id', realtime, manager)
  const states: string[] = []
  messenger.onOutgoing(messages => states.push(...messages.map(item => item.status!)))
  messenger.onDelivery(update => { assert.equal('content' in update, false); states.push(update.status!) })
  messenger.subscribe(() => {}, error => { throw error })
  await messenger.sendText('chat', 'private')
  assert.deepEqual(states, ['pending', 'accepted', 'delivered'])
  delivered({ ...destination, payload: null, delivered_at: user.createdAt })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(decodes, 2)
  assert.equal(states.length, 3)
})


test('metadata restoration never reads or decodes history; opening reads exactly one chat page', async () => {
  const { manager, inbox, api } = setup()
  await manager.activate(user)
  inbox.snapshot = async () => { throw new Error('Full restoration forbidden') }
  const reads: unknown[] = []
  inbox.readChatHistory = async (_scope, id, limit, before) => {
    reads.push([id, limit, before])
    return { envelopes: [envelope(1)], outgoing: [], nextBefore: null }
  }
  let decodes = 0
  const messenger = new MessengerService(api, {
    async buildOutgoing() { return [] },
    async decodeIncoming() { decodes++; return 'private' },
  }, () => 'unused', undefined, manager)
  assert.deepEqual((await messenger.restoreMetadata()).messages, [])
  assert.equal(decodes, 0)
  assert.equal(reads.length, 0)
  assert.equal((await messenger.loadChatHistory('chat')).messages.length, 1)
  assert.deepEqual(reads, [['chat', 50, undefined]])
  assert.equal(decodes, 1)
})

test('history decoding rejects a result when the user changes during decode', async () => {
  const { manager, inbox, api } = setup()
  await manager.activate(user)
  inbox.readChatHistory = async () => ({ envelopes: [envelope(1)], outgoing: [], nextBefore: null })
  let release!: () => void
  const decoding = new Promise<void>(resolve => { release = resolve })
  const messenger = new MessengerService(api, {
    async buildOutgoing() { return [] },
    async decodeIncoming() { await decoding; return 'old private content' },
  }, () => 'unused', undefined, manager)
  const page = messenger.loadChatHistory('chat')
  await new Promise(resolve => setImmediate(resolve))
  await manager.activate({ ...user, id: 'other' })
  release()
  await assert.rejects(page, /session changed/)
})
