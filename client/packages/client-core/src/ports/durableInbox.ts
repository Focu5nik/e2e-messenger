import type { ChatReadCursor, ChatReadState, DeviceIdentity, DirectChat, SentMessage } from '../domain/models.ts'
import type { MailboxEnvelope, MessageEnvelope, SendMessageRequest } from '../protocol/contracts.ts'
import type { DeviceIdentityStore } from './platform.ts'

export type DurableDeviceIdentity = DeviceIdentity & { generation: string }
export type InboxScope = { userId: string; deviceId: string; generation: string }
export type OutgoingCommand = { command: SendMessageRequest; accepted: SentMessage | null; createdAt?: string }
export type InboxSnapshot = {
  cursor: number
  envelopes: MailboxEnvelope[]
  outgoing: OutgoingCommand[]
  chats: DirectChat[]
}

export type ChatHistoryCursor = { createdAt: string; id: string }
export type ChatHistoryPage = {
  envelopes: MailboxEnvelope[]
  outgoing: OutgoingCommand[]
  nextBefore: ChatHistoryCursor | null
}

// Implementations must reject stale generations and resolve writes only after commit.
// Store opaque envelope bytes, never decoded private message content.
export interface DurableInbox extends DeviceIdentityStore {
  readChatReadStates?(scope: InboxScope): Promise<ChatReadState[]>
  mergeChatReadCursor?(scope: InboxScope, cursor: ChatReadCursor): Promise<ChatReadState>
  advanceLocalReadCursor?(scope: InboxScope, chatId: string, seq: number): Promise<ChatReadState>
  mergeSentMetadata?(scope: InboxScope, message: SentMessage): Promise<SentMessage>
  getSentMetadata?(scope: InboxScope, messageId: string): Promise<SentMessage | null>
  needsSequenceBackfill?(scope: InboxScope): Promise<boolean>
  finishSequenceBackfill?(scope: InboxScope): Promise<void>

  read(): Promise<DurableDeviceIdentity | null>
  readMetadata(scope: InboxScope): Promise<{ cursor: number; chats: DirectChat[] }>
  // Full export for diagnostics; ordinary operations use indexed reads.
  snapshot(scope: InboxScope): Promise<InboxSnapshot>
  readCursor(scope: InboxScope): Promise<number>
  getPendingAcknowledgments(scope: InboxScope): Promise<MailboxEnvelope[]>
  getOutgoingToRecover(scope: InboxScope): Promise<OutgoingCommand[]>
  // Newest first, with an exclusive (timestamp, ID) cursor shared by both stores.
  readChatHistory(scope: InboxScope, chatId: string, limit: number, before?: ChatHistoryCursor): Promise<ChatHistoryPage>
  // Retain early receipts and merge them atomically when acceptance is saved.
  applyDeliveryReceipt(scope: InboxScope, receipt: MessageEnvelope): Promise<OutgoingCommand | null>
  getOutgoing(scope: InboxScope, clientMessageId: string): Promise<OutgoingCommand | null>
  // One transaction upserts the full page and advances the cursor. A mismatched
  // expected cursor is a concurrent writer conflict and must not change anything.
  // Return only inserted or changed envelopes, with preserved local payloads.
  commitPage(scope: InboxScope, expectedCursor: number, envelopes: MailboxEnvelope[], nextCursor: number): Promise<MailboxEnvelope[]>
  // Replacement is allowed only after an explicit server rejection, in one transaction.
  putOutgoing(scope: InboxScope, command: SendMessageRequest, replaceRejected?: boolean): Promise<OutgoingCommand>
  acceptOutgoing(scope: InboxScope, message: SentMessage): Promise<OutgoingCommand>
  saveChats(scope: InboxScope, chats: DirectChat[]): Promise<void>
}
