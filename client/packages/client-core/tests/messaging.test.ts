import assert from 'node:assert/strict'
import test from 'node:test'
import { atob } from 'node:buffer'
import { TextDecoder } from 'node:util'
import {
  ClientError, MessengerService, PlaintextMessageCodec, mergeMessages,
  type DisplayMessage, type MailboxEnvelope, type MailboxPage,
  type MessagingGateway, type RealtimeGateway, type SendMessageRequest,
  type SentMessage, type TextEncoding,
} from '../src/index.ts'

const encoding: TextEncoding = {
  encodeUtf8: (value) => Buffer.from(value, 'utf8'),
  decodeUtf8: (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  encodeBase64: (bytes) => Buffer.from(bytes).toString('base64'),
  decodeBase64: (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
}
const codec = new PlaintextMessageCodec(encoding)
const createId = () => 'generated-id'

function mailboxEnvelope(overrides: Partial<MailboxEnvelope> = {}): MailboxEnvelope {
  return {
    id: 'envelope-1',
    message_id: 'message-1',
    chat_id: 'chat-1',
    sender_user_id: 'sender-1',
    sender_device_id: 'sender-device-1',
    client_message_id: 'client-message-1',
    recipient_device_id: 'recipient-device-1',
    mailbox_seq: 1,
    protocol_version: 0,
    envelope_type: 'PLAINTEXT',
    payload: 'b25l',
    created_at: '2026-09-07T10:00:00Z',
    message_created_at: '2026-09-07T10:00:00Z',
    expires_at: '2026-10-22T10:00:00Z',
    delivered_at: null,
    payload_purged_at: null,
    ...overrides,
  }
}

function sentMessage(command: SendMessageRequest): SentMessage {
  return {
    id: 'accepted-message',
    chatId: command.chat_id,
    senderUserId: 'sender-1',
    senderDeviceId: 'sender-device-1',
    clientMessageId: command.client_message_id,
    createdAt: '2026-09-07T10:00:00Z',
    envelopes: [],
  }
}

test('plaintext codec owns UTF-8/base64 conversion and builds one envelope per device', async () => {
  const content = 'Hello, Bob 🌍'
  const envelopes = await codec.buildOutgoing(content, [
    { id: 'bob-device-1', protocolVersion: 0 },
    { id: 'bob-device-2', protocolVersion: 0 },
  ])

  assert.deepEqual(envelopes.map((envelope) => envelope.recipient_device_id), [
    'bob-device-1',
    'bob-device-2',
  ])
  assert.ok(envelopes.every((envelope) => envelope.protocol_version === 0))
  assert.ok(envelopes.every((envelope) => envelope.envelope_type === 'PLAINTEXT'))
  assert.equal(await codec.decodeIncoming(envelopes[0]), content)
})

test('messenger refetches changed targets and retries with the same client message id', async () => {
  const commands: SendMessageRequest[] = []
  let destinationCall = 0
  const api: MessagingGateway = {
    async getDestinationDevices() {
      destinationCall += 1
      return destinationCall === 1
        ? [{ id: 'old-device', protocolVersion: 0 }]
        : [
            { id: 'new-device-1', protocolVersion: 0 },
            { id: 'new-device-2', protocolVersion: 0 },
          ]
    },
    async sendMessage(command) {
      commands.push(command)
      if (commands.length === 1) {
        throw new ClientError('Destination devices changed; refresh and retry.', 'delivery_targets_changed')
      }
      return sentMessage(command)
    },
    async getMailbox() {
      throw new Error('Unexpected mailbox request')
    },
  }

  const messenger = new MessengerService(api, codec, () => 'stable-client-id')
  const accepted = await messenger.sendText('chat-1', 'hello')

  assert.equal(accepted.clientMessageId, 'stable-client-id')
  assert.equal(destinationCall, 2)
  assert.deepEqual(commands.map((command) => command.client_message_id), [
    'stable-client-id',
    'stable-client-id',
  ])
  assert.deepEqual(
    commands[1].envelopes.map((envelope) => envelope.recipient_device_id),
    ['new-device-1', 'new-device-2'],
  )
})

for (const ready of [false, true]) {
  for (const targetsChanged of [false, true]) {
    test(`messenger rejects empty destinations ${targetsChanged ? 'after target refresh' : 'before sending'} over ${ready ? 'realtime' : 'HTTP'}`, async () => {
      let destinationCalls = 0
      let codecCalls = 0
      const httpCommands: SendMessageRequest[] = []
      const socketCommands: SendMessageRequest[] = []
      const api: MessagingGateway = {
        async getDestinationDevices() {
          destinationCalls += 1
          return targetsChanged && destinationCalls === 1
            ? [{ id: 'old-device', protocolVersion: 0 }]
            : []
        },
        async sendMessage(command) {
          httpCommands.push(command)
          throw new ClientError('Changed', 'delivery_targets_changed')
        },
        async getMailbox() { throw new Error('Unexpected mailbox call') },
      }
      const realtime: RealtimeGateway = {
        start() {}, stop() {}, ready,
        async sendMessage(command) {
          socketCommands.push(command)
          throw new ClientError('Changed', 'delivery_targets_changed')
        },
        onMessage: () => () => {}, onReady: () => () => {},
      }
      const messenger = new MessengerService(api, {
        async buildOutgoing(content, devices) {
          codecCalls += 1
          return codec.buildOutgoing(content, devices)
        },
        decodeIncoming: (envelope) => codec.decodeIncoming(envelope),
      }, createId, realtime)

      await assert.rejects(messenger.sendText('chat-1', 'hello'), (error: unknown) => {
        assert.ok(error instanceof ClientError)
        assert.equal(error.code, 'no_recipient_devices')
        assert.equal(error.message, 'This person has no available devices to receive messages. Try again after they register a device.')
        return true
      })
      const expectedSends = targetsChanged ? 1 : 0
      assert.equal(destinationCalls, expectedSends + 1)
      assert.equal(codecCalls, expectedSends)
      assert.equal(httpCommands.length, ready ? 0 : expectedSends)
      assert.equal(socketCommands.length, ready ? expectedSends : 0)
      assert.ok([...httpCommands, ...socketCommands].every((command) => command.envelopes.length === 1))
    })
  }
}

test('messenger pages the mailbox, decodes live envelopes, and advances over tombstones', async () => {
  const requestedCursors: number[] = []
  const pages: MailboxPage[] = [
    {
      envelopes: [
        mailboxEnvelope(),
        mailboxEnvelope({
          id: 'envelope-2',
          message_id: 'message-2',
          mailbox_seq: 2,
          payload: null,
          payload_purged_at: '2026-09-07T11:00:00Z',
        }),
      ],
      nextSeq: 2,
      hasMore: true,
    },
    {
      envelopes: [
        mailboxEnvelope({
          id: 'envelope-3',
          message_id: 'message-3',
          client_message_id: 'client-message-3',
          mailbox_seq: 3,
          payload: 'dGhyZWU=',
        }),
      ],
      nextSeq: 3,
      hasMore: false,
    },
  ]
  const api: MessagingGateway = {
    async getDestinationDevices() {
      throw new Error('Unexpected destination request')
    },
    async sendMessage() {
      throw new Error('Unexpected send request')
    },
    async getMailbox(afterSeq) {
      requestedCursors.push(afterSeq)
      const page = pages.shift()
      if (!page) throw new Error('Unexpected mailbox page')
      return page
    },
  }

  const expectedEnvelopes = pages.flatMap((page) => page.envelopes)
  const result = await new MessengerService(api, codec, createId).loadMailbox()

  assert.deepEqual(requestedCursors, [0, 2])
  assert.deepEqual(result.messages.map((message) => message.content), ['one', 'three'])
  assert.equal(result.tombstoneCount, 1)
  assert.equal(result.nextSeq, 3)
  assert.deepEqual(result.envelopes, expectedEnvelopes)
})

test('messenger retries only delivery-target changes and stops after one retry', async () => {
  for (const [error, expectedAttempts] of [
    [new ClientError('Changed', 'delivery_targets_changed'), 2],
    [new ClientError('Conflict', 'conflict'), 1],
    [new ClientError('Offline', 'network_error'), 1],
    [new ClientError('Unconfirmed', 'delivery_unconfirmed'), 1],
    [Object.assign(new Error('Changed'), { code: 'delivery_targets_changed' }), 1],
  ] as const) {
    let destinations = 0
    const commands: SendMessageRequest[] = []
    const api: MessagingGateway = {
      async getDestinationDevices() { destinations += 1; return [{ id: 'device-1', protocolVersion: 0 }] },
      async sendMessage(command) { commands.push(command); throw error },
      async getMailbox() { throw new Error('Unexpected mailbox call') },
    }
    await assert.rejects(new MessengerService(api, codec, () => 'stable-id').sendText('chat-1', 'hello'),
      (caught: unknown) => caught === error)
    assert.equal(commands.length, expectedAttempts)
    assert.equal(destinations, expectedAttempts)
    assert.ok(commands.every((command) => command.client_message_id === 'stable-id'))
  }
})

test('messenger uses the codec before real-time send and does not retry an ambiguous socket failure over HTTP', async () => {
  let httpSends = 0
  const socketCommands: SendMessageRequest[] = []
  const api: MessagingGateway = {
    async getDestinationDevices() { return [{ id: 'recipient-device-1', protocolVersion: 0 }] },
    async sendMessage(command) { httpSends += 1; return sentMessage(command) },
    async getMailbox() { return { envelopes: [], nextSeq: 0, hasMore: false } },
  }
  const realtime: RealtimeGateway = {
    start() {}, stop() {}, ready: true,
    async sendMessage(command) { socketCommands.push(command); throw new ClientError('Delivery is unconfirmed.', 'delivery_unconfirmed') },
    onMessage: () => () => {}, onReady: () => () => {},
  }
  const messenger = new MessengerService(api, codec, () => 'immutable-id', realtime)
  await assert.rejects(messenger.sendText('chat-1', 'hello'), /unconfirmed/)
  assert.equal(socketCommands.length, 1)
  assert.equal(socketCommands[0].client_message_id, 'immutable-id')
  assert.equal(await codec.decodeIncoming(socketCommands[0].envelopes[0]), 'hello')
  assert.equal(httpSends, 0)
  Object.assign(realtime, { ready: false })
  await messenger.sendText('chat-1', 'offline socket')
  assert.equal(httpSends, 1)
})

test('real-time incoming envelopes use the same decoder, skip tombstones and stop after unsubscribe', async () => {
  let receive: ((envelope: MailboxEnvelope) => void) | undefined
  const realtime: RealtimeGateway = {
    start() {}, stop() {}, ready: true,
    async sendMessage(command) { return sentMessage(command) },
    onMessage(handler) { receive = handler; return () => {} },
    onReady: () => () => {},
  }
  const api: MessagingGateway = {
    async getDestinationDevices() { return [] },
    async sendMessage(command) { return sentMessage(command) },
    async getMailbox() { return { envelopes: [mailboxEnvelope()], nextSeq: 1, hasMore: false } },
  }
  const messenger = new MessengerService(api, codec, createId, realtime)
  const messages: unknown[] = []
  const errors: unknown[] = []
  const unsubscribe = messenger.subscribe((message) => messages.push(...message), (error) => errors.push(error))
  receive?.(mailboxEnvelope())
  receive?.(mailboxEnvelope({ payload: null }))
  const mailbox = await messenger.loadMailbox()
  assert.deepEqual(messages, mailbox.messages)
  assert.deepEqual(errors, [])
  receive?.(mailboxEnvelope())
  unsubscribe()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(messages.length, 1)
})

test('codec rejects unsupported protocols and malformed payloads', async () => {
  await assert.rejects(codec.buildOutgoing('hello', [{ id: 'device-1', protocolVersion: 1 }]),
    /does not support plaintext messaging/)
  for (const overrides of [{ protocol_version: 1 }, { envelope_type: 'OTHER' }]) {
    await assert.rejects(codec.decodeIncoming({ ...mailboxEnvelope(), payload: 'b25l', ...overrides }),
      /Unsupported message envelope/)
  }
  for (const payload of ['%%%', 'a', '/w==', 'wyg=']) {
    await assert.rejects(codec.decodeIncoming({ ...mailboxEnvelope(), payload }), /not valid UTF-8 plaintext/)
  }
})

test('messenger generates one ID per send and preserves an explicitly supplied ID through retries', async () => {
  let generated = 0
  const commands: SendMessageRequest[] = []
  const api: MessagingGateway = {
    async getDestinationDevices() { return [{ id: 'device-1', protocolVersion: 0 }] },
    async sendMessage(command) {
      commands.push(command)
      if (commands.length % 2 === 1) throw new ClientError('Changed', 'delivery_targets_changed')
      return sentMessage(command)
    },
    async getMailbox() { throw new Error('Unexpected mailbox call') },
  }
  const messenger = new MessengerService(api, codec, () => `generated-${++generated}`)
  await messenger.sendText('chat-1', 'first')
  await messenger.sendText('chat-1', 'second')
  await messenger.sendText('chat-1', 'third', 'caller-id')
  assert.equal(generated, 2)
  assert.deepEqual(commands.map((command) => command.client_message_id), [
    'generated-1', 'generated-1', 'generated-2', 'generated-2', 'caller-id', 'caller-id',
  ])
})

test('mailbox rejects stalled and regressing cursors when more pages remain', async () => {
  for (const nextSeq of [5, 4]) {
    let calls = 0
    const api: MessagingGateway = {
      async getDestinationDevices() { throw new Error('Unexpected destination request') },
      async sendMessage() { throw new Error('Unexpected send request') },
      async getMailbox(afterSeq, limit) {
        calls += 1
        assert.equal(afterSeq, 5)
        assert.equal(limit, 100)
        return { envelopes: [], nextSeq, hasMore: true }
      },
    }
    await assert.rejects(new MessengerService(api, codec, createId).loadMailbox(5), /paging did not advance/)
    assert.equal(calls, 1)
  }
})

test('empty final mailbox pages preserve the starting cursor', async () => {
  const api: MessagingGateway = {
    async getDestinationDevices() { return [] },
    async sendMessage(command) { return sentMessage(command) },
    async getMailbox(afterSeq) { return { envelopes: [], nextSeq: afterSeq, hasMore: false } },
  }
  const messenger = new MessengerService(api, codec, createId)
  assert.deepEqual(await messenger.loadMailbox(7), { messages: [], envelopes: [], nextSeq: 7, tombstoneCount: 0 })
  messenger.subscribe(() => assert.fail('Unexpected message'), () => assert.fail('Unexpected error'))()
  messenger.onReady(() => assert.fail('Unexpected ready event'))()
})

test('realtime reports decode errors and releases message and ready subscriptions', async () => {
  let receive: ((envelope: MailboxEnvelope) => void) | undefined
  let ready: (() => void) | undefined
  let messageUnsubscribed = false
  let readyUnsubscribed = false
  const realtime: RealtimeGateway = {
    start() {}, stop() {}, ready: true,
    async sendMessage(command) { return sentMessage(command) },
    onMessage(handler) { receive = handler; return () => { messageUnsubscribed = true } },
    onReady(handler) { ready = handler; return () => { readyUnsubscribed = true } },
  }
  const api: MessagingGateway = {
    async getDestinationDevices() { return [] },
    async sendMessage(command) { return sentMessage(command) },
    async getMailbox() { return { envelopes: [], nextSeq: 0, hasMore: false } },
  }
  const errors: unknown[] = []
  let readyCalls = 0
  const messenger = new MessengerService(api, codec, createId, realtime)
  const unsubscribe = messenger.subscribe(() => assert.fail('Unexpected message'), (error) => errors.push(error))
  const unsubscribeReady = messenger.onReady(() => { readyCalls += 1 })
  ready?.()
  assert.equal(readyCalls, 1)
  receive?.(mailboxEnvelope({ payload: '%%%' }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(errors.length, 1)
  assert.match((errors[0] as Error).message, /not valid UTF-8 plaintext/)
  receive?.(mailboxEnvelope({ payload: '%%%' }))
  unsubscribe()
  unsubscribeReady()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(errors.length, 1)
  assert.equal(messageUnsubscribed, true)
  assert.equal(readyUnsubscribed, true)
})

test('mergeMessages deduplicates by message ID, replaces overlaps, and sorts without mutating inputs', () => {
  const first: DisplayMessage = {
    messageId: 'first', chatId: 'chat-1', senderUserId: 'sender-1', content: 'old', createdAt: '2026-09-07T10:00:00Z',
  }
  const last = { ...first, messageId: 'last', createdAt: '2026-09-07T10:02:00Z' }
  const updated = { ...first, content: 'updated' }
  const middle = { ...first, messageId: 'middle', createdAt: '2026-09-07T10:01:00Z' }
  const current = [last, first]
  const incoming = [middle, updated, middle]
  assert.deepEqual(mergeMessages(current, incoming), [updated, middle, last])
  assert.deepEqual(current, [last, first])
  assert.deepEqual(incoming, [middle, updated, middle])
})


test('V6 optimistic pending IDs converge to one accepted message and late snapshots cannot regress delivery', () => {
  const pending = { messageId: 'pending:client', clientMessageId: 'client', senderDeviceId: 'device',
    chatId: 'chat', senderUserId: 'user', content: 'private', createdAt: '2026-09-19T00:00:00Z', status: 'pending' as const }
  const accepted = { ...pending, messageId: 'server-message', status: 'accepted' as const }
  const delivered = { ...accepted, status: 'delivered' as const }
  assert.deepEqual(mergeMessages([pending], [accepted]), [accepted])
  assert.deepEqual(mergeMessages([delivered], [pending]), [delivered])
  assert.deepEqual(mergeMessages([delivered], [accepted]), [delivered])
})

test('merge preserves references for repeated snapshots and keeps command identities scoped to chat and device', () => {
  const pending: DisplayMessage = { messageId: 'pending', chatId: 'chat', senderUserId: 'user', senderDeviceId: 'device',
    clientMessageId: 'client', content: 'private', createdAt: '2026-09-19T00:00:00Z', status: 'pending' }
  const accepted = { ...pending, messageId: 'accepted', status: 'accepted' as const,
    deliveries: [{ deviceId: 'recipient', deliveredAt: null }] }
  const current = [accepted]
  assert.equal(mergeMessages(current, structuredClone(current)), current)
  assert.equal(mergeMessages(current, [pending]), current)
  assert.equal(mergeMessages(current, []), current)
  const otherChat = { ...pending, messageId: 'other-chat', chatId: 'other' }
  const otherDevice = { ...pending, messageId: 'other-device', senderDeviceId: 'other' }
  assert.deepEqual(mergeMessages([pending, otherChat, otherDevice], [accepted]), [accepted, otherDevice, otherChat])
})
