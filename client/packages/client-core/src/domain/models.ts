import type { MailboxEnvelope, MessageEnvelope } from '../protocol/contracts.ts'

// Timestamps stay as server-provided strings, preserving precision and offsets.
export type User = { id: string; username: string; status: string; createdAt: string }
export type CurrentUser = User & { deviceId: string; sessionId: string }
export type DeviceIdentity = { id: string; name: string }
export type LoginDevice = DeviceIdentity

export type Device = {
  id: string
  name: string
  protocolVersion: number
  createdAt: string
  lastSeenAt: string
  revokedAt: string | null
  isCurrent: boolean
}

export type DirectChat = { id: string; type: 'DIRECT'; createdAt: string; otherUser: User }
export type DestinationDevice = { id: string; protocolVersion: number }

export type SentMessage = {
  id: string
  chatId: string
  senderUserId: string
  senderDeviceId: string
  clientMessageId: string
  createdAt: string
  envelopes: MessageEnvelope[]
}

export type MailboxPage = { envelopes: MailboxEnvelope[]; nextSeq: number; hasMore: boolean }

export type ReceivedMessage = {
  envelopeId: string
  messageId: string
  chatId: string
  senderUserId: string
  senderDeviceId: string
  clientMessageId: string
  mailboxSeq: number
  content: string
  createdAt: string
}

export type DisplayMessage = Pick<
  ReceivedMessage,
  'messageId' | 'chatId' | 'senderUserId' | 'content' | 'createdAt'
>
