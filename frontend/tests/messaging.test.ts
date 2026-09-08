import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../src/shared/api/client.ts'
import type {
  MailboxEnvelope,
  MailboxPage,
  SendMessageRequest,
  SentMessage,
} from '../src/shared/api/client.ts'
import { PlaintextMessageCodec } from '../src/features/messaging/lib/messageCodec.ts'
import {
  MessengerService,
  type MessagingApi,
} from '../src/features/messaging/lib/messengerService.ts'

const codec = new PlaintextMessageCodec()

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
    chat_id: command.chat_id,
    sender_user_id: 'sender-1',
    sender_device_id: 'sender-device-1',
    client_message_id: command.client_message_id,
    created_at: '2026-09-07T10:00:00Z',
    envelopes: [],
  }
}

test('plaintext codec owns UTF-8/base64 conversion and builds one envelope per device', async () => {
  const content = 'Hello, Bob 🌍'
  const envelopes = await codec.buildOutgoing(content, [
    { id: 'bob-device-1', protocol_version: 0 },
    { id: 'bob-device-2', protocol_version: 0 },
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
  const api: MessagingApi = {
    async getDestinationDevices() {
      destinationCall += 1
      return destinationCall === 1
        ? [{ id: 'old-device', protocol_version: 0 }]
        : [
            { id: 'new-device-1', protocol_version: 0 },
            { id: 'new-device-2', protocol_version: 0 },
          ]
    },
    async sendMessage(command) {
      commands.push(command)
      if (commands.length === 1) {
        throw new ApiError('Destination devices changed; refresh and retry.', 409, 'delivery_targets_changed')
      }
      return sentMessage(command)
    },
    async getMailbox() {
      throw new Error('Unexpected mailbox request')
    },
  }

  const messenger = new MessengerService(api, codec, () => 'stable-client-id')
  const accepted = await messenger.sendText('chat-1', 'hello')

  assert.equal(accepted.client_message_id, 'stable-client-id')
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
      next_seq: 2,
      has_more: true,
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
      next_seq: 3,
      has_more: false,
    },
  ]
  const api: MessagingApi = {
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

  const result = await new MessengerService(api, codec).loadMailbox()

  assert.deepEqual(requestedCursors, [0, 2])
  assert.deepEqual(result.messages.map((message) => message.content), ['one', 'three'])
  assert.equal(result.tombstoneCount, 1)
  assert.equal(result.nextSeq, 3)
})
