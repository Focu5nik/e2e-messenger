import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientError, type RealtimeGateway, type SendMessageRequest } from '@secure-messenger/client-core'
import { ApiError } from '../src/shared/api/errors.ts'
import { WebSocketManager, type SocketAuth } from '../src/shared/api/webSocketManager.ts'
import { mailboxEnvelopeDto, sentMessageDto, timestamp } from './apiFixtures.ts'

class FakeSocket {
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  send(data: string) { this.sent.push(data) }
  open() { this.readyState = 1; this.onopen?.() }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
  close(code = 1006) { this.readyState = 3; this.onclose?.({ code }) }
}

const command: SendMessageRequest = {
  chat_id: 'chat-1', client_message_id: 'client-1',
  envelopes: [{ recipient_device_id: 'device-1', protocol_version: 0, envelope_type: 'PLAINTEXT', payload: 'aGk=' }],
}

test('sync requests correlate validated pages independently from message sends', async () => {
  const { manager, sockets } = setup()
  await assert.rejects(manager.getMailbox(0), /unavailable/)
  manager.start()
  await Promise.resolve()
  const socket = sockets[0]
  socket.open()
  socket.receive({ type: 'auth.ok' })
  const syncing = manager.getMailbox(4, 25)
  const request = JSON.parse(socket.sent[1])
  assert.equal(request.type, 'sync.request')
  assert.deepEqual(request.data, { after_seq: 4, limit: 25 })
  socket.receive({ type: 'sync.response', request_id: request.request_id, data: { envelopes: [], next_seq: 'invalid', has_more: false } })
  socket.receive({ type: 'message.accepted', request_id: request.request_id, data: sentMessageDto })
  socket.receive({ type: 'sync.response', request_id: 'other', data: { envelopes: [], next_seq: 99, has_more: false } })
  socket.receive({ type: 'sync.response', request_id: request.request_id, data: { envelopes: [], next_seq: 4, has_more: false } })
  assert.deepEqual(await syncing, { envelopes: [], nextSeq: 4, hasMore: false })
  manager.stop()
})

test('sync errors, timeouts and disconnects reject pending pages and clear timers', async () => {
  for (const failure of ['error', 'timeout', 'disconnect'] as const) {
    const { manager, sockets, timers, runTimer } = setup()
    manager.start()
    await Promise.resolve()
    sockets[0].open()
    sockets[0].receive({ type: 'auth.ok' })
    const syncing = manager.getMailbox(0)
    if (failure === 'error') {
      const { request_id } = JSON.parse(sockets[0].sent[1])
      sockets[0].receive({ type: 'error', request_id, error: { code: 'invalid_event', message: 'Invalid sync request', status: 422 } })
    } else if (failure === 'timeout') runTimer(15_000)
    else manager.stop()
    await assert.rejects(syncing)
    manager.stop()
    assert.equal(timers.size, 0)
  }
})

function setup() {
  const timers = new Map<number, { handler: () => void; delay: number }>()
  let timerId = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout(handler: () => void, delay: number) { timers.set(++timerId, { handler, delay }); return timerId },
      clearTimeout(id: number) { timers.delete(id) },
    },
  })
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const refreshes: boolean[] = []
  let clearSession: (() => void) | null = null
  const auth: SocketAuth = {
    getWebSocketUrl: () => 'wss://messenger.example/api/ws',
    async getAccessToken(refresh = false) { refreshes.push(refresh); return refresh ? 'fresh-token' : 'initial-token' },
    onSessionCleared(handler) { clearSession = handler; return () => { clearSession = null } },
  }
  const manager = new WebSocketManager(auth, (url) => {
    urls.push(url)
    const socket = new FakeSocket()
    sockets.push(socket)
    return socket as unknown as WebSocket
  })
  return {
    manager, sockets, urls, refreshes, auth, timers,
    clearSession: () => clearSession?.(),
    runTimer(delay: number) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay)
      assert.ok(entry, `No timer with delay ${delay}`)
      timers.delete(entry[0])
      entry[1].handler()
    },
  }
}

test('authenticates in the first frame and routes only authenticated events and correlated replies', async () => {
  const { manager, sockets, urls } = setup()
  let readyCount = 0
  const received: unknown[] = []
  manager.onReady(() => { readyCount += 1 })
  manager.onMessage((envelope) => received.push(envelope))
  manager.start()
  manager.start()
  await Promise.resolve()
  assert.equal(sockets.length, 1)
  assert.deepEqual(urls, ['wss://messenger.example/api/ws'])
  const socket = sockets[0]
  socket.open()
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: 'auth', access_token: 'initial-token' })
  socket.receive({ type: 'message.new', data: { id: 'premature' } })
  assert.deepEqual(received, [])
  assert.equal(manager.ready, false)
  await assert.rejects(manager.sendMessage(command), /unavailable/)
  socket.receive({ type: 'auth.ok' })
  socket.receive({ type: 'auth.ok' })
  assert.equal(readyCount, 1)
  socket.onmessage?.({ data: 'invalid JSON' })
  socket.receive(null)
  socket.receive({ type: 'message.new', data: { id: 'malformed-envelope' } })
  assert.deepEqual(received, [])
  socket.receive({ type: 'message.new', data: mailboxEnvelopeDto })
  assert.deepEqual(received, [mailboxEnvelopeDto])

  const sending = manager.sendMessage(command)
  const frame = JSON.parse(socket.sent[1])
  assert.equal(frame.type, 'message.send')
  assert.deepEqual(frame.data, command)
  socket.receive({ type: 'message.accepted', request_id: 'unrelated', data: { id: 'wrong' } })
  socket.receive({ type: 'message.accepted', request_id: frame.request_id, data: { id: 'malformed' } })
  socket.receive({ type: 'message.accepted', request_id: frame.request_id, data: sentMessageDto })
  assert.deepEqual(await sending, {
    id: 'message-1', chatId: 'chat-1', senderUserId: 'user-1', senderDeviceId: 'device-1',
    clientMessageId: 'client-1', createdAt: timestamp, envelopes: sentMessageDto.envelopes,
  })
  manager.stop()
})

test('preserves server rejection codes for the existing delivery-target retry', async () => {
  const { manager, sockets } = setup()
  manager.start()
  await Promise.resolve()
  sockets[0].open()
  sockets[0].receive({ type: 'auth.ok' })
  const sending = manager.sendMessage(command)
  const { request_id } = JSON.parse(sockets[0].sent[1])
  sockets[0].receive({ type: 'error', request_id, error: { code: 'delivery_targets_changed', message: 'Refresh destinations.', status: 409 } })
  await assert.rejects(sending, (error: unknown) => error instanceof ClientError
    && error.code === 'delivery_targets_changed' && error instanceof ApiError
    && error.status === 409 && error.serverCode === 'delivery_targets_changed')
  manager.stop()
})

test('reconnects with backoff, refreshes expired authentication and never replays ambiguous sends', async () => {
  const { manager, sockets, refreshes, runTimer } = setup()
  manager.start()
  await Promise.resolve()
  sockets[0].open()
  sockets[0].receive({ type: 'auth.ok' })
  const sending = manager.sendMessage(command)
  sockets[0].close(4401)
  await assert.rejects(sending, (error: unknown) => error instanceof ClientError
    && error.code === 'delivery_unconfirmed' && /unconfirmed/.test(error.message))
  runTimer(500)
  await Promise.resolve()
  assert.deepEqual(refreshes, [false, true])
  sockets[1].open()
  assert.deepEqual(JSON.parse(sockets[1].sent[0]), { type: 'auth', access_token: 'fresh-token' })
  sockets[1].close()
  runTimer(1000)
  await Promise.resolve()
  sockets[2].open()
  sockets[2].receive({ type: 'auth.ok' })
  assert.equal(sockets[2].sent.length, 1)
  assert.equal(manager.ready, true)
  manager.stop()
})

test('session clearing closes immediately and ignores late refresh/socket events', async () => {
  const { manager, sockets, auth, clearSession, timers } = setup()
  let resolveToken: ((token: string) => void) | undefined
  auth.getAccessToken = () => new Promise((resolve) => { resolveToken = resolve })
  manager.start()
  clearSession()
  resolveToken?.('stale-token')
  await Promise.resolve()
  assert.equal(sockets.length, 0)
  assert.equal(timers.size, 0)
  auth.getAccessToken = async () => 'current-token'
  manager.start()
  await Promise.resolve()
  sockets[0].open()
  sockets[0].receive({ type: 'auth.ok' })
  const sending = manager.sendMessage(command)
  clearSession()
  await assert.rejects(sending, /unconfirmed/)
  sockets[0].receive({ type: 'auth.ok' })
  assert.equal(manager.ready, false)
  assert.equal(sockets[0].readyState, 3)
  assert.equal(timers.size, 0)
})

test('replacement and origin rejection stop reconnecting; auth and send timeouts are bounded', async () => {
  for (const code of [4001, 4403]) {
    const { manager, sockets, timers } = setup()
    manager.start()
    await Promise.resolve()
    sockets[0].close(code)
    assert.equal(timers.size, 0)
    assert.equal(manager.ready, false)
  }
  const { manager, sockets, runTimer } = setup()
  manager.start()
  await Promise.resolve()
  runTimer(10_000)
  assert.equal(sockets[0].readyState, 3)
  runTimer(500)
  await Promise.resolve()
  sockets[1].open()
  sockets[1].receive({ type: 'auth.ok' })
  const sending = manager.sendMessage(command)
  runTimer(15_000)
  await assert.rejects(sending, /timed out/)
  assert.equal(sockets[1].sent.length, 2)
  manager.stop()
})

test('the gateway can restart after cleanup and backoff is capped and reset by authentication', async () => {
  const { manager, sockets, timers, runTimer } = setup()
  const realtime: RealtimeGateway = manager
  let readyCount = 0
  const unsubscribe = realtime.onReady(() => { readyCount += 1 })
  realtime.start()
  await Promise.resolve()
  for (const delay of [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    sockets.at(-1)!.close()
    runTimer(delay)
    await Promise.resolve()
  }
  const previous = sockets.at(-1)!
  previous.open()
  previous.receive({ type: 'auth.ok' })
  assert.equal(readyCount, 1)
  previous.close()
  runTimer(500)
  await Promise.resolve()
  realtime.stop()
  realtime.stop()
  assert.equal(timers.size, 0)
  unsubscribe()
  unsubscribe()
  realtime.start()
  await Promise.resolve()
  previous.receive({ type: 'auth.ok' })
  assert.equal(realtime.ready, false)
  sockets.at(-1)!.open()
  sockets.at(-1)!.receive({ type: 'auth.ok' })
  assert.equal(realtime.ready, true)
  assert.equal(readyCount, 1)
  realtime.stop()
  assert.equal(timers.size, 0)
})

test('a synchronous socket send failure rejects as unconfirmed and clears its confirmation timer', async () => {
  const { manager, sockets, timers } = setup()
  manager.start()
  await Promise.resolve()
  sockets[0].open()
  sockets[0].receive({ type: 'auth.ok' })
  sockets[0].send = () => { throw new Error('Socket closed during send') }
  await assert.rejects(manager.sendMessage(command), (error: unknown) => error instanceof ClientError
    && error.code === 'delivery_unconfirmed')
  assert.equal(timers.size, 0)
  manager.stop()
})


test('V6 ACK serialization correlates recipient responses separately from sender delivery events', async () => {
  const { manager, sockets } = setup()
  manager.start()
  await Promise.resolve()
  const socket = sockets[0]
  socket.open()
  socket.receive({ type: 'auth.ok' })
  const deliveries: string[] = []
  const unsubscribe = manager.onDelivered(envelope => deliveries.push(envelope.id))
  const ack = manager.acknowledgeEnvelope(mailboxEnvelopeDto.id)
  const frame = JSON.parse(socket.sent[1])
  assert.equal(frame.type, 'message.delivered')
  assert.deepEqual(frame.data, { envelope_id: mailboxEnvelopeDto.id })
  const receipt = { ...sentMessageDto.envelopes[0], payload: null, delivered_at: timestamp, payload_purged_at: timestamp }
  socket.receive({ type: 'message.delivered', request_id: frame.request_id, data: receipt })
  assert.deepEqual(await ack, receipt)
  assert.deepEqual(deliveries, [])
  socket.receive({ type: 'message.delivered', data: receipt })
  assert.deepEqual(deliveries, [receipt.id])
  unsubscribe()
  socket.receive({ type: 'message.delivered', data: receipt })
  assert.equal(deliveries.length, 1)
  manager.stop()
})

test('V6 interrupted ACKs reject and release pending timers for durable retry', async () => {
  for (const failure of ['error', 'timeout', 'disconnect'] as const) {
    const { manager, sockets, timers, runTimer } = setup()
    manager.start()
    await Promise.resolve()
    const socket = sockets[0]
    socket.open()
    socket.receive({ type: 'auth.ok' })
    const ack = manager.acknowledgeEnvelope('envelope')
    const { request_id } = JSON.parse(socket.sent[1])
    if (failure === 'error') socket.receive({ type: 'error', request_id, error: { code: 'envelope_not_found', message: 'Unavailable', status: 404 } })
    else if (failure === 'timeout') runTimer(15_000)
    else manager.stop()
    await assert.rejects(ack)
    manager.stop()
    assert.equal(timers.size, 0)
  }
})

test('outgoing request failures preserve operation errors and release timers', async () => {
  const operations = [
    {
      request: (manager: WebSocketManager) => manager.acknowledgeEnvelope('envelope'),
      timeout: 'Delivery acknowledgment timed out.',
      lost: 'Connection lost during delivery acknowledgment.',
      code: 'network_error',
    },
    {
      request: (manager: WebSocketManager) => manager.sendMessage(command),
      timeout: 'Message confirmation timed out. Delivery is unconfirmed.',
      lost: 'Connection lost. Message delivery is unconfirmed.',
      code: 'delivery_unconfirmed',
    },
    {
      request: (manager: WebSocketManager) => manager.getMailbox(0),
      timeout: 'Mailbox sync timed out. Reconnect to try again.',
      lost: 'Connection lost during mailbox sync.',
      code: 'network_error',
    },
  ]
  for (const operation of operations) {
    for (const failure of ['timeout', 'send', 'disconnect'] as const) {
      const { manager, sockets, timers, runTimer } = setup()
      manager.start()
      await Promise.resolve()
      const socket = sockets[0]
      socket.open()
      socket.receive({ type: 'auth.ok' })
      if (failure === 'send') socket.send = () => { throw new Error('Socket closed') }
      const response = operation.request(manager)
      if (failure === 'timeout') runTimer(15_000)
      if (failure === 'disconnect') manager.stop()
      await assert.rejects(response, (error: unknown) => error instanceof ApiError
        && error.message === (failure === 'timeout' ? operation.timeout : operation.lost)
        && error.code === operation.code)
      assert.equal(timers.size, 0)
      manager.stop()
    }
  }
})
