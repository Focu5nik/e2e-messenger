import type { DeviceIdentity, DirectChat, SentMessage } from '../domain/models.ts'
import type { MailboxEnvelope, SendMessageRequest } from '../protocol/contracts.ts'
import type { DeviceIdentityStore } from './platform.ts'

export type DurableDeviceIdentity = DeviceIdentity & { generation: string }
export type InboxScope = { userId: string; deviceId: string; generation: string }
export type OutgoingCommand = { command: SendMessageRequest; accepted: SentMessage | null }
export type InboxSnapshot = {
  cursor: number
  envelopes: MailboxEnvelope[]
  outgoing: OutgoingCommand[]
  chats: DirectChat[]
}

// Implementations must reject stale generations and resolve writes only after commit.
// Store opaque envelope bytes, never decoded private message content.
export interface DurableInbox extends DeviceIdentityStore {
  read(): Promise<DurableDeviceIdentity | null>
  snapshot(scope: InboxScope): Promise<InboxSnapshot>
  // One transaction upserts the full page and advances the cursor. A mismatched
  // expected cursor is a concurrent writer conflict and must not change anything.
  commitPage(scope: InboxScope, expectedCursor: number, envelopes: MailboxEnvelope[], nextCursor: number): Promise<void>
  putOutgoing(scope: InboxScope, command: SendMessageRequest): Promise<void>
  // Only an explicit server rejection permits removing/rebuilding a command.
  rejectOutgoing(scope: InboxScope, clientMessageId: string): Promise<void>
  acceptOutgoing(scope: InboxScope, message: SentMessage): Promise<void>
  saveChats(scope: InboxScope, chats: DirectChat[]): Promise<void>
}
