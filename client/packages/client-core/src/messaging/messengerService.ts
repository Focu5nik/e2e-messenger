import type { ChatReadState, DirectChat, DisplayMessage, MessageDeliveryUpdate, ReceivedMessage, SentMessage } from '../domain/models.ts'
import type { ChatHistoryCursor, InboxScope, InboxSnapshot, OutgoingCommand } from '../ports/durableInbox.ts'
import type { MailboxEnvelope } from '../protocol/contracts.ts'
import type { MessagingGateway, RealtimeGateway } from '../ports/gateways.ts'
import { deliveryState, OutgoingManager } from './outgoingManager.ts'
import { ReadCursorManager } from './readCursorManager.ts'
import type { IdGenerator, Scheduler } from '../ports/platform.ts'
import type { MessageCodec } from './messageCodec.ts'
import type { SyncManager } from './syncManager.ts'

const MAILBOX_PAGE_SIZE = 100

export type MailboxLoadResult = {
  messages: DisplayMessage[]
  envelopes: MailboxEnvelope[]
  nextSeq: number
  tombstoneCount: number
}

export class MessengerService {
  private readonly api: MessagingGateway
  private readonly codec: MessageCodec<string>
  private readonly outgoing: OutgoingManager
  private readonly realtime?: RealtimeGateway
  private readonly sync?: SyncManager
  private readonly reads?: ReadCursorManager
  private activityHandlers = new Set<(chatIds: string[]) => void>()
  onChatActivity(handler: (chatIds: string[]) => void): () => void {
    this.activityHandlers.add(handler)
    return () => { this.activityHandlers.delete(handler) }
  }

  private historyChats: Set<string> | undefined
  setHistoryChats(chatIds: string[]): void { this.historyChats = new Set(chatIds) }

  private outgoingHandlers = new Set<(messages: DisplayMessage[]) => void>()

  constructor(
    api: MessagingGateway,
    codec: MessageCodec<string>,
    createClientMessageId: IdGenerator,
    realtime?: RealtimeGateway,
    sync?: SyncManager,
    scheduler?: Scheduler,
  ) {
    this.api = api
    this.codec = codec
    this.realtime = realtime
    this.sync = sync
    this.outgoing = new OutgoingManager(api, codec, createClientMessageId,
      (commands, scope) => this.publishOutgoing(commands, scope), realtime, sync, scheduler)
    if (sync) this.reads = new ReadCursorManager(sync, api, realtime, scheduler)
  }

  sendText(chatId: string, content: string, clientMessageId?: string): Promise<SentMessage> {
    return this.outgoing.sendText(chatId, content, clientMessageId)
  }

  subscribe(
    onMessage: (messages: ReceivedMessage[]) => void,
    onError: (error: unknown) => void,
  ): () => void {
    let active = true
    this.reads?.start()

    const reportError = (error: unknown) => {
      if (active) onError(error)
    }

    const handleIncomingEnvelope = async (envelope: MailboxEnvelope): Promise<void> => {
      const scope = this.sync?.scope()
      let messages: ReceivedMessage[]

      if (this.sync) {
        const changes = await this.sync.ingest(envelope)
        if (this.sync.scope() !== scope) return

        const chatIds = [...new Set(changes.envelopes.map(item => item.chat_id))]
        if (active && chatIds.length) {
          for (const handler of this.activityHandlers) handler(chatIds)
        }

        const visibleEnvelopes = changes.envelopes.filter(item => !this.historyChats || this.historyChats.has(item.chat_id))
        const decoded = await Promise.all(visibleEnvelopes.map(item => this.decodeEnvelope(item)))
        messages = decoded.filter((message): message is ReceivedMessage => message !== null)
      } else {
        const message = await this.decodeEnvelope(envelope)
        messages = message ? [message] : []
      }

      if (!active || (this.sync && this.sync.scope() !== scope)) return
      if (messages.length) onMessage(messages)
    }

    const unsubscribe = this.realtime?.onMessage(envelope => {
      void handleIncomingEnvelope(envelope).catch(reportError)
    })
    const unsubscribeDelivered = this.outgoing.subscribe(reportError)

    const unsubscribeRead = this.realtime?.onReadCursor?.(cursor => {
      void this.reads?.merge(cursor).catch(reportError)
    })

    return () => {
      active = false
      this.reads?.stop()
      unsubscribeRead?.()
      unsubscribe?.()
      unsubscribeDelivered()
    }
  }

  onReadState(handler: (state: ChatReadState) => void): () => void {
    return this.reads?.onChange(handler) ?? (() => {})
  }

  advanceReadCursor(chatId: string, seq: number): Promise<void> {
    return this.reads?.advance(chatId, seq) ?? Promise.resolve()
  }

  onReady(handler: () => void): () => void {
    return this.realtime?.onReady(handler) ?? (() => {})
  }

  async loadMailbox(afterSeq = 0): Promise<MailboxLoadResult> {
    if (this.sync) {
      const scope = this.sync.scope()
      const changes = await this.sync.synchronize()
      if (this.sync.scope() !== scope) throw new Error('Message session changed.')
      await this.outgoing.recoverSentMetadata(scope)
      if (this.sync.scope() !== scope) throw new Error('Message session changed.')
      // Fetch read cursors after metadata: messages excluded by a concurrent read
      // must still acquire their final status, even on a newly registered device.
      await this.reads?.synchronize()
      if (this.sync.scope() !== scope) throw new Error('Message session changed.')
      await this.outgoing.recoverOutgoing()
      if (this.sync.scope() !== scope) throw new Error('Message session changed.')
      const decoded = await this.decodeSnapshot({ ...changes, outgoing: [], chats: [] })
      if (this.sync.scope() !== scope) throw new Error('Message session changed.')
      return decoded
    }
    const messages: ReceivedMessage[] = []
    const envelopes: MailboxEnvelope[] = []
    let tombstoneCount = 0
    let cursor = afterSeq

    while (true) {
      const page = await this.api.getMailbox(cursor, MAILBOX_PAGE_SIZE)
      envelopes.push(...page.envelopes)

      for (const envelope of page.envelopes) {
        if (envelope.payload === null) {
          tombstoneCount += 1
          continue
        }

        const message = await this.decodeEnvelope(envelope)
        if (message) messages.push(message)
      }

      if (!page.hasMore) {
        return { messages, envelopes, nextSeq: page.nextSeq, tombstoneCount }
      }
      if (page.nextSeq <= cursor) {
        throw new Error('Mailbox paging did not advance.')
      }
      cursor = page.nextSeq
    }
  }

  async restoreMetadata(): Promise<MailboxLoadResult & { chats: DirectChat[] }> {
    if (!this.sync) return { messages: [], envelopes: [], nextSeq: 0, tombstoneCount: 0, chats: [] }
    const scope = this.sync.scope()
    await this.reads?.restore()
    const metadata = await this.sync.inbox.readMetadata(scope)
    if (this.sync.scope() !== scope) throw new Error('Message session changed.')
    return { messages: [], envelopes: [], nextSeq: metadata.cursor, tombstoneCount: 0, chats: metadata.chats }
  }

  async loadChatHistory(chatId: string, before?: ChatHistoryCursor): Promise<{ messages: DisplayMessage[]; nextBefore: ChatHistoryCursor | null }> {
    if (!this.sync) return { messages: [], nextBefore: null }
    const scope = this.sync.scope()
    const page = await this.sync.inbox.readChatHistory(scope, chatId, 50, before)
    if (this.sync.scope() !== scope) throw new Error('Message session changed.')
    const decoded = await this.decodeSnapshot({ ...page, chats: [], cursor: 0 }, false)
    if (this.sync.scope() !== scope) throw new Error('Message session changed.')
    return { messages: decoded.messages, nextBefore: page.nextBefore }
  }

  async cacheChats(chats: DirectChat[]): Promise<void> {
    if (this.sync) await this.sync.inbox.saveChats(this.sync.scope(), chats)
  }

  onDelivery(handler: (update: MessageDeliveryUpdate) => void): () => void {
    return this.outgoing.onDelivery(handler)
  }

  onOutgoing(handler: (messages: DisplayMessage[]) => void): () => void {
    this.outgoingHandlers.add(handler)
    return () => { this.outgoingHandlers.delete(handler) }
  }

  retryOutgoing(clientMessageId: string): Promise<void> {
    return this.outgoing.retryOutgoing(clientMessageId)
  }

  private async publishOutgoing(outgoingCommands: OutgoingCommand[], scope: InboxScope): Promise<void> {
    if (!this.sync || !this.outgoingHandlers.size || !outgoingCommands.length) return
    if (this.sync.scope() !== scope) return
    const messages: DisplayMessage[] = []
    for (const outgoing of outgoingCommands) {
      if (this.historyChats && !this.historyChats.has(outgoing.command.chat_id)) continue
      const message = await this.decodeOutgoing(outgoing)
      if (this.sync.scope() !== scope) return
      if (message) messages.push(message)
    }
    if (messages.length) for (const handler of this.outgoingHandlers) handler(messages)
  }

  private async decodeOutgoing({ command, accepted, createdAt }: OutgoingCommand): Promise<DisplayMessage | null> {
    if (!command.envelopes[0] || !this.sync) return null
    const scope = this.sync.scope()
    return {
      messageId: accepted?.id ?? `pending:${scope.deviceId}:${command.client_message_id}`,
      clientMessageId: command.client_message_id, senderDeviceId: scope.deviceId,
      historyId: `outgoing:${command.client_message_id}`,
      chatId: command.chat_id, chatSeq: accepted?.chatSeq, senderUserId: scope.userId,
      createdAt: createdAt ?? accepted?.createdAt ?? '',
      content: await this.codec.decodeIncoming(command.envelopes[0]),
      ...deliveryState(accepted),
    }
  }

  private async decodeSnapshot(snapshot: InboxSnapshot, filter = true): Promise<MailboxLoadResult> {
    const messages: DisplayMessage[] = []
    for (const envelope of snapshot.envelopes) {
      if (filter && this.historyChats && !this.historyChats.has(envelope.chat_id)) continue
      const message = await this.decodeEnvelope(envelope)
      if (message) messages.push(message)
    }
    for (const outgoing of snapshot.outgoing) {
      const message = await this.decodeOutgoing(outgoing)
      if (message) messages.push(message)
    }
    return {
      messages, envelopes: snapshot.envelopes, nextSeq: snapshot.cursor,
      tombstoneCount: snapshot.envelopes.filter((envelope) => envelope.payload === null).length,
    }
  }

  private async decodeEnvelope(envelope: MailboxEnvelope): Promise<(ReceivedMessage & Partial<DisplayMessage>) | null> {
    if (envelope.payload === null) return null
    const content = await this.codec.decodeIncoming({
      recipient_device_id: envelope.recipient_device_id,
      protocol_version: envelope.protocol_version,
      envelope_type: envelope.envelope_type,
      payload: envelope.payload,
    })
    const scope = this.sync?.scope()
    const sent = scope && envelope.sender_user_id === scope.userId
      ? await this.sync!.inbox.getSentMetadata?.(scope, envelope.message_id) : null
    return {
      ...(scope && envelope.sender_user_id === scope.userId ? deliveryState(sent ?? null) : {}),
      ...(scope && envelope.sender_user_id === scope.userId && !sent ? { status: 'accepted' as const } : {}),
      envelopeId: envelope.id,
      historyId: `envelope:${envelope.id}`,
      messageId: envelope.message_id,
      chatId: envelope.chat_id,
      chatSeq: envelope.chat_seq,
      senderUserId: envelope.sender_user_id,
      senderDeviceId: envelope.sender_device_id,
      clientMessageId: envelope.client_message_id,
      mailboxSeq: envelope.mailbox_seq,
      content,
      createdAt: envelope.message_created_at,
    }
  }
}
