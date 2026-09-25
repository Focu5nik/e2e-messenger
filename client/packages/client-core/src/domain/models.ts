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
export type DestinationDevice = { id: string; protocolVersion: number; userId?: string }

export type SentMessage = {
  id: string
  chatId: string
  chatSeq?: number
  senderUserId: string
  senderDeviceId: string
  clientMessageId: string
  createdAt: string
  envelopes: MessageEnvelope[]
}

export type MailboxPage = { envelopes: MailboxEnvelope[]; nextSeq: number; hasMore: boolean }

export type ReceivedMessage = {
  historyId?: string
  envelopeId: string
  messageId: string
  chatId: string
  chatSeq?: number
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
> & {
  chatSeq?: number
  clientMessageId?: string
  senderDeviceId?: string
  // Immutable local history index tie-breaker.
  historyId?: string
  status?: 'pending' | 'accepted' | 'delivered' | 'read'
  deliveries?: Array<{ deviceId: string; deliveredAt: string | null }>
}

export type MessageDeliveryUpdate = Pick<DisplayMessage, 'messageId' | 'chatId' | 'chatSeq' | 'status' | 'deliveries'>

export type ChatReadCursor = { chatId: string; userId: string; lastReadSeq: number; updatedAt: string | null }
export type ChatReadState = { chatId: string; ownLocalReadSeq: number; ownConfirmedReadSeq: number; peerLastReadSeq: number }
export type ChatStatesPage = { states: Array<{ chatId: string; lastMessageSeq: number; readStates: ChatReadCursor[] }>; nextChatId: string | null; hasMore: boolean }
export type SentMessagesPage = { messages: SentMessage[]; nextMessageId: string | null; hasMore: boolean }
