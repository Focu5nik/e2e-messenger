import type {
  CurrentUser, DestinationDevice, Device, DirectChat, LoginDevice, MailboxPage,
  SentMessage, User, ChatReadCursor, ChatStatesPage, SentMessagesPage,
} from '../domain/models.ts'
import type { MailboxEnvelope, MessageEnvelope, SendMessageRequest } from '../protocol/contracts.ts'

// Gateways expose domain values and reject with ClientError for known failures.
export interface SessionGateway {
  register(username: string, password: string): Promise<User>
  login(username: string, password: string, device: LoginDevice): Promise<void>
  restoreSession(): Promise<boolean>
  logout(): Promise<void>
  // Authentication has expired; excludes explicit logout and anonymous restoration.
  onSessionExpired(handler: () => void): () => void
  // Session credentials were cleared, including logout, replacement, and expiry.
  onSessionCleared(handler: () => void): () => void
}

export interface AccountGateway {
  getCurrentUser(): Promise<CurrentUser>
  getDevices(): Promise<Device[]>
  revokeDevice(deviceId: string): Promise<void>
}

export interface ChatGateway {
  searchUsers(search: string): Promise<User[]>
  getChats(): Promise<DirectChat[]>
  getChat(chatId: string): Promise<DirectChat>
  createDirectChat(userId: string): Promise<DirectChat>
}

export interface MessagingGateway {
  getChatStates?(afterChatId?: string, limit?: number): Promise<ChatStatesPage>
  getSentMessages?(afterMessageId?: string, limit?: number, unreadOnly?: boolean): Promise<SentMessagesPage>
  acknowledgeEnvelope?(envelopeId: string): Promise<MessageEnvelope>
  findSentMessage?(clientMessageId: string): Promise<SentMessage | null>
  getDestinationDevices(chatId: string): Promise<DestinationDevice[]>
  sendMessage(command: SendMessageRequest): Promise<SentMessage>
  getMailbox(afterSeq: number, limit?: number): Promise<MailboxPage>
}

export interface RealtimeGateway {
  advanceReadCursor?(chatId: string, lastReadSeq: number): Promise<ChatReadCursor>
  onReadCursor?(handler: (cursor: ChatReadCursor) => void): () => void
  acknowledgeEnvelope?(envelopeId: string): Promise<MessageEnvelope>
  onDelivered?(handler: (envelope: MessageEnvelope) => void): () => void
  readonly ready: boolean
  start(): void
  stop(): void
  sendMessage(command: SendMessageRequest): Promise<SentMessage>
  getMailbox?(afterSeq: number, limit?: number): Promise<MailboxPage>
  onMessage(handler: (envelope: MailboxEnvelope) => void): () => void
  onReady(handler: () => void): () => void
}
