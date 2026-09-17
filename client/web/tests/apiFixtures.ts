import type {
  CurrentUserDto, DeviceDto, DirectChatDto, MailboxEnvelope, MailboxPageDto,
  SentMessageDto, TokenResponse, UserDto,
} from '@secure-messenger/client-core'

export const timestamp = '2026-09-07T10:00:00.123456+03:00'
export const userDto = {
  id: 'user-1', username: 'alice', status: 'active', created_at: timestamp,
} satisfies UserDto
export const currentUserDto = {
  ...userDto, device_id: 'device-1', session_id: 'session-1',
} satisfies CurrentUserDto
export const deviceDto = {
  id: 'device-1', name: 'Browser', protocol_version: 0, created_at: timestamp,
  last_seen_at: timestamp, revoked_at: null, is_current: true,
} satisfies DeviceDto
export const chatDto = {
  id: 'chat-1', type: 'DIRECT', created_at: timestamp, other_user: userDto,
} satisfies DirectChatDto
export const envelopeDto = {
  id: 'envelope-1', message_id: 'message-1', recipient_device_id: 'device-1',
  mailbox_seq: 1, protocol_version: 0, envelope_type: 'PLAINTEXT', payload: 'aGk=',
  created_at: timestamp, expires_at: '2026-10-22T10:00:00Z',
  delivered_at: null, payload_purged_at: null,
}
export const mailboxEnvelopeDto = {
  ...envelopeDto, chat_id: 'chat-1', sender_user_id: 'user-1', sender_device_id: 'device-1',
  client_message_id: 'client-1', message_created_at: timestamp,
} satisfies MailboxEnvelope
export const sentMessageDto = {
  id: 'message-1', chat_id: 'chat-1', sender_user_id: 'user-1', sender_device_id: 'device-1',
  client_message_id: 'client-1', created_at: timestamp, envelopes: [envelopeDto],
} satisfies SentMessageDto
export const mailboxPageDto = {
  envelopes: [mailboxEnvelopeDto], next_seq: 1, has_more: false,
} satisfies MailboxPageDto
export const tokensDto = {
  access_token: 'test-access', token_type: 'bearer', expires_in: 900,
} satisfies TokenResponse
