import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mapCurrentUser, mapDestinationDevice, mapDevice, mapDirectChat, mapEmpty, mapError,
  mapList, mapMailboxEnvelope, mapMailboxPage, mapMessageEnvelope, mapSentMessage,
  mapServerEvent, mapTokens, mapUser,
} from '../src/shared/api/mappers.ts'
import {
  chatDto, currentUserDto, deviceDto, envelopeDto, mailboxEnvelopeDto, mailboxPageDto,
  sentMessageDto, timestamp, tokensDto, userDto,
} from './apiFixtures.ts'

test('account and chat mappers produce explicit camelCase models without extra wire fields', () => {
  const user = { id: 'user-1', username: 'alice', status: 'active', createdAt: timestamp }
  assert.deepEqual(mapUser({ ...userDto, extra: 'ignored' }), user)
  assert.deepEqual(mapCurrentUser(currentUserDto), { ...user, deviceId: 'device-1', sessionId: 'session-1' })
  assert.deepEqual(mapDevice(deviceDto), {
    id: 'device-1', name: 'Browser', protocolVersion: 0, createdAt: timestamp,
    lastSeenAt: timestamp, revokedAt: null, isCurrent: true,
  })
  assert.equal(mapDevice({ ...deviceDto, revoked_at: timestamp }).revokedAt, timestamp)
  assert.deepEqual(mapDirectChat(chatDto), { id: 'chat-1', type: 'DIRECT', createdAt: timestamp, otherUser: user })
  assert.deepEqual(mapDestinationDevice({ id: 'device-1', protocol_version: 0, user_id: 'peer-1' }), { id: 'device-1', protocolVersion: 0, userId: 'peer-1' })
  assert.deepEqual(mapList([userDto], mapUser), [user])
  assert.deepEqual(mapList([], mapUser), [])
})

test('message mappers preserve envelope wire fields, null payloads, and exact timestamps', () => {
  assert.deepEqual(mapMessageEnvelope(envelopeDto), envelopeDto)
  assert.deepEqual(mapMailboxEnvelope(mailboxEnvelopeDto), mailboxEnvelopeDto)
  const tombstone = { ...mailboxEnvelopeDto, payload: null, delivered_at: timestamp, payload_purged_at: timestamp }
  assert.deepEqual(mapMailboxEnvelope(tombstone), tombstone)
  assert.deepEqual(mapSentMessage(sentMessageDto), {
    id: 'message-1', chatId: 'chat-1', chatSeq: 1, senderUserId: 'user-1', senderDeviceId: 'device-1',
    clientMessageId: 'client-1', createdAt: timestamp, envelopes: [envelopeDto],
  })
  assert.deepEqual(mapMailboxPage(mailboxPageDto), { envelopes: [mailboxEnvelopeDto], nextSeq: 1, hasMore: false })
  assert.deepEqual(mapTokens(tokensDto), tokensDto)
  assert.equal(mapEmpty(undefined), undefined)
  assert.throws(() => mapEmpty({}), /Invalid server response/)
})

const shapes: Array<[string, (value: unknown) => unknown, Record<string, unknown>]> = [
  ['user', mapUser, userDto], ['current user', mapCurrentUser, currentUserDto],
  ['device', mapDevice, deviceDto], ['chat', mapDirectChat, chatDto],
  ['destination device', mapDestinationDevice, { id: 'device-1', protocol_version: 0, user_id: 'peer-1' }],
  ['envelope', mapMessageEnvelope, envelopeDto], ['mailbox envelope', mapMailboxEnvelope, mailboxEnvelopeDto],
  ['sent message', mapSentMessage, sentMessageDto], ['mailbox page', mapMailboxPage, mailboxPageDto],
  ['tokens', mapTokens, tokensDto],
]

for (const [name, map, dto] of shapes) {
  test(`${name} mapper rejects missing required fields and incorrect JSON types`, () => {
    for (const input of [null, undefined, [], 'wrong', 1]) assert.throws(() => map(input), /Invalid server response/)
    for (const key of Object.keys(dto)) {
      const missing = { ...dto }
      delete missing[key]
      assert.throws(() => map(missing), /Invalid server response/, `missing ${key}`)
      const wrongType = typeof dto[key] === 'boolean' ? 'invalid' : false
      assert.throws(() => map({ ...dto, [key]: wrongType }), /Invalid server response/, `invalid ${key}`)
    }
  })
}

test('nested values, arrays, timestamps, discriminators and numeric fields are validated', () => {
  // Booleans are valid only in their own fields; use strings to catch coercion.
  assert.throws(() => mapDevice({ ...deviceDto, is_current: 'true' }), /is_current/)
  assert.throws(() => mapMailboxPage({ ...mailboxPageDto, has_more: 'false' }), /has_more/)
  assert.throws(() => mapDirectChat({ ...chatDto, other_user: { ...userDto, username: null } }), /username/)
  assert.throws(() => mapMailboxPage({ ...mailboxPageDto, envelopes: [{ ...mailboxEnvelopeDto, payload: 1 }] }), /payload/)
  assert.throws(() => mapSentMessage({ ...sentMessageDto, envelopes: [null] }), /object/)
  assert.throws(() => mapList({}, mapUser), /array/)
  assert.throws(() => mapDirectChat({ ...chatDto, type: 'GROUP' }), /type/)
  for (const value of ['', 'yesterday', '2026-09-07', '2026-99-99T00:00:00Z']) {
    assert.throws(() => mapUser({ ...userDto, created_at: value }), /created_at/)
  }
  for (const value of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '0']) {
    assert.throws(() => mapDestinationDevice({ id: 'device-1', protocol_version: value }), /protocol_version/)
    assert.throws(() => mapMailboxPage({ ...mailboxPageDto, next_seq: value }), /next_seq/)
  }
  assert.throws(() => mapTokens({ ...tokensDto, token_type: 'basic' }), /token_type/)
  assert.throws(() => mapTokens({ ...tokensDto, access_token: '' }), /token/)
  assert.throws(() => mapTokens({ ...tokensDto, expires_in: 0 }), /token/)
})

test('error mapping tolerates malformed bodies and preserves valid messages and codes', () => {
  const fallback = 'Request failed (422)'
  assert.deepEqual(mapError({ detail: 'denied' }, fallback), { message: 'denied', code: null })
  assert.deepEqual(mapError({ detail: [{ loc: ['body', 'username'], msg: 'Required' }, { msg: 'Too short' }] }, fallback), {
    message: 'Required. Too short', code: null,
  })
  assert.deepEqual(mapError({ detail: { code: 'delivery_targets_changed', message: 'Retry' } }, fallback), {
    message: 'Retry', code: 'delivery_targets_changed',
  })
  for (const value of [undefined, null, [], 1, 'wrong', {}, { detail: null }, { detail: 1 },
    { detail: [null, {}, { msg: 42 }] }, { detail: { code: 1, message: {} } }]) {
    assert.deepEqual(mapError(value, fallback), { message: fallback, code: null })
  }
})

test('realtime data uses the same validated message contracts as HTTP', () => {
  assert.deepEqual(mapServerEvent({ type: 'auth.ok' }), { type: 'auth.ok' })
  assert.deepEqual(mapServerEvent({ type: 'message.new', data: mailboxEnvelopeDto }), {
    type: 'message.new', data: mailboxEnvelopeDto,
  })
  assert.deepEqual(mapServerEvent({ type: 'message.accepted', request_id: 'request-1', data: sentMessageDto }), {
    type: 'message.accepted', request_id: 'request-1', data: mapSentMessage(sentMessageDto),
  })
  const error = { type: 'error', request_id: 'request-1', error: { code: 'denied', message: 'Denied', status: 403 } }
  assert.deepEqual(mapServerEvent(error), error)
  for (const frame of [{ type: 'unknown' }, { type: 'message.new', data: {} },
    { type: 'message.accepted', data: sentMessageDto }, { ...error, error: { ...error.error, status: '403' } }]) {
    assert.throws(() => mapServerEvent(frame), /Invalid server response/)
  }
})
