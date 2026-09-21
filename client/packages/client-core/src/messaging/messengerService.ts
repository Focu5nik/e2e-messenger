import { ClientError } from '../domain/errors.ts'
import type { DirectChat, DisplayMessage, MessageDeliveryUpdate, ReceivedMessage, SentMessage } from '../domain/models.ts'
import type { ChatHistoryCursor, InboxScope, InboxSnapshot, OutgoingCommand } from '../ports/durableInbox.ts'
import type { MailboxEnvelope } from '../protocol/contracts.ts'
import type { MessagingGateway, RealtimeGateway } from '../ports/gateways.ts'
import type { IdGenerator } from '../ports/platform.ts'
import type { MessageCodec } from './messageCodec.ts'
import type { SyncManager } from './syncManager.ts'

const DELIVERY_TARGETS_CHANGED = 'delivery_targets_changed'
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
  private readonly createClientMessageId: IdGenerator
  private readonly realtime?: RealtimeGateway
  private readonly sync?: SyncManager
  private activityHandlers = new Set<(chatIds: string[]) => void>()
  onChatActivity(handler: (chatIds: string[]) => void): () => void {
    this.activityHandlers.add(handler)
    return () => { this.activityHandlers.delete(handler) }
  }

  private historyChats: Set<string> | undefined
  setHistoryChats(chatIds: string[]): void { this.historyChats = new Set(chatIds) }

  private outgoingHandlers = new Set<(messages: DisplayMessage[]) => void>()
  private recovering: Promise<void> | null = null
  private inFlight = new Set<string>()
  private pendingDeliveries = new Map<string, { scope: InboxScope; update: MessageDeliveryUpdate }>()
  private deliveryHandlers = new Set<(update: MessageDeliveryUpdate) => void>()

  constructor(
    api: MessagingGateway,
    codec: MessageCodec<string>,
    createClientMessageId: IdGenerator,
    realtime?: RealtimeGateway,
    sync?: SyncManager,
  ) {
    this.api = api
    this.codec = codec
    this.createClientMessageId = createClientMessageId
    this.realtime = realtime
    this.sync = sync
  }

  async sendText(chatId: string, content: string, clientMessageId?: string): Promise<SentMessage> {
    const stableClientMessageId = clientMessageId ?? this.createClientMessageId()
    const scope = this.sync?.scope()
    if (scope && clientMessageId) {
      const existing = await this.sync!.inbox.getOutgoing(scope, clientMessageId)
      if (this.sync!.scope() !== scope) throw new Error('Message session changed.')
      if (existing) {
        if (existing.command.chat_id !== chatId) throw new Error('Outgoing command belongs to another chat.')
        return this.recoverCommand(existing)
      }
    }

    return this.sendNewText(chatId, content, stableClientMessageId)
  }

  private async sendNewText(chatId: string, content: string, stableClientMessageId: string, replaceRejected = false, changes?: Map<string, OutgoingCommand>): Promise<SentMessage> {
    const scope = this.sync?.scope()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const destinationDevices = await this.api.getDestinationDevices(chatId)
      if (destinationDevices.length === 0) {
        throw new ClientError(
          'This person has no available devices to receive messages. Try again after they register a device.',
          'no_recipient_devices',
        )
      }
      const envelopes = await this.codec.buildOutgoing(content, destinationDevices)

      try {
        const command = {
          chat_id: chatId,
          client_message_id: stableClientMessageId,
          envelopes,
        }
        this.inFlight.add(stableClientMessageId)
        if (scope) {
          // Keep a retryable durable row until fresh envelopes have been built.
          const outgoing = await this.sync!.inbox.putOutgoing(scope, command, replaceRejected)
          await this.outgoingChanged(outgoing, scope, changes)
        }
        if (scope && this.sync!.scope() !== scope) throw new Error('Message session changed.')
        const accepted = await (this.realtime?.ready
          ? this.realtime.sendMessage(command)
          : this.api.sendMessage(command))
        if (scope) {
          const outgoing = await this.sync!.inbox.acceptOutgoing(scope, accepted)
          await this.outgoingChanged(outgoing, scope, changes)
        }
        return accepted
      } catch (error) {
        if (!this.isDeliveryTargetsChanged(error)) throw error
        replaceRejected = true
        if (attempt === 1) throw error
      } finally {
        this.inFlight.delete(stableClientMessageId)
        this.publishDeliveries()
      }
    }

    throw new Error('Message delivery failed.')
  }

  subscribe(
    onMessage: (messages: ReceivedMessage[]) => void,
    onError: (error: unknown) => void,
  ): () => void {
    let active = true
    const unsubscribe = this.realtime?.onMessage((envelope) => {
      const scope = this.sync?.scope()
      const incoming = this.sync
        ? this.sync.ingest(envelope).then(async (changes) => {
          if (this.sync!.scope() !== scope) return []
          const chatIds = [...new Set(changes.envelopes.map(item => item.chat_id))]
          if (active && chatIds.length) for (const handler of this.activityHandlers) handler(chatIds)
          const messages = await Promise.all(changes.envelopes.filter(item => !this.historyChats || this.historyChats.has(item.chat_id)).map((item) => this.decodeEnvelope(item)))
          return messages.filter((message): message is ReceivedMessage => message !== null)
        })
        : this.decodeEnvelope(envelope).then((message) => message ? [message] : [])
      void incoming.then((messages) => {
        if (active && (!this.sync || this.sync.scope() === scope) && messages.length) onMessage(messages)
      }).catch((error: unknown) => {
        if (active) onError(error)
      })
    })
    const unsubscribeDelivered = this.realtime?.onDelivered?.((receipt) => {
      if (!this.sync) return
      const scope = this.sync.scope()
      void this.sync.inbox.applyDeliveryReceipt(scope, receipt).then(outgoing => {
        if (!active || this.sync!.scope() !== scope || !outgoing?.accepted) return
        const accepted = outgoing.accepted
        const update: MessageDeliveryUpdate = {
          messageId: accepted.id, chatId: accepted.chatId,
          ...this.deliveryState(accepted),
        }
        this.pendingDeliveries.set(update.messageId, { scope, update })
        this.publishDeliveries()
      }).catch(error => { if (active) onError(error) })
    })
    return () => { active = false; unsubscribe?.(); unsubscribeDelivered?.() }
  }

  onReady(handler: () => void): () => void {
    return this.realtime?.onReady(handler) ?? (() => {})
  }

  async loadMailbox(afterSeq = 0): Promise<MailboxLoadResult> {
    if (this.sync) {
      const scope = this.sync.scope()
      const changes = await this.sync.synchronize()
      if (this.sync.scope() !== scope) throw new Error('Message session changed.')
      await this.recoverOutgoing()
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

  async restoreLocal(): Promise<MailboxLoadResult & { chats: DirectChat[] }> {
    if (!this.sync) return { messages: [], envelopes: [], nextSeq: 0, tombstoneCount: 0, chats: [] }
    const snapshot = await this.sync.snapshot()
    return { ...await this.decodeSnapshot(snapshot), chats: snapshot.chats }
  }

  async cacheChats(chats: DirectChat[]): Promise<void> {
    if (this.sync) await this.sync.inbox.saveChats(this.sync.scope(), chats)
  }

  private publishDeliveries(): void {
    // Acceptance must reach subscribers before a racing metadata-only receipt.
    if (this.inFlight.size || this.recovering) return
    for (const [id, { scope, update }] of this.pendingDeliveries) {
      this.pendingDeliveries.delete(id)
      try { if (this.sync?.scope() !== scope) continue } catch { continue }
      for (const handler of this.deliveryHandlers) handler(update)
    }
  }

  onDelivery(handler: (update: MessageDeliveryUpdate) => void): () => void {
    this.deliveryHandlers.add(handler)
    return () => { this.deliveryHandlers.delete(handler) }
  }

  onOutgoing(handler: (messages: DisplayMessage[]) => void): () => void {
    this.outgoingHandlers.add(handler)
    return () => { this.outgoingHandlers.delete(handler) }
  }

  async retryOutgoing(clientMessageId: string): Promise<void> {
    if (!this.sync) return
    const scope = this.sync.scope()
    const outgoing = await this.sync.inbox.getOutgoing(scope, clientMessageId)
    if (this.sync.scope() !== scope) throw new Error('Message session changed.')
    if (outgoing) await this.recoverCommand(outgoing)
  }

  private async recoverOutgoing(): Promise<void> {
    if (!this.sync || !this.api.findSentMessage) return
    if (this.recovering) return this.recovering
    const scope = this.sync.scope()
    const operation = async () => {
      const changes = new Map<string, OutgoingCommand>()
      for (const outgoing of await this.sync!.inbox.getOutgoingToRecover(scope)) {
        if (this.sync!.scope() !== scope) throw new Error('Message session changed.')
        if (this.inFlight.has(outgoing.command.client_message_id)) continue
        if (outgoing.accepted?.envelopes.length && outgoing.accepted.envelopes.every(item => item.delivered_at)) continue
        try { await this.recoverCommand(outgoing, changes) }
        catch {
          // One unconfirmed command must not block other messages or inbox display.
          if (this.sync!.scope() !== scope) throw new Error('Message session changed.')
        }
      }
      await this.publishOutgoing([...changes.values()], scope)
    }
    this.recovering = operation().finally(() => { this.recovering = null; this.publishDeliveries() })
    return this.recovering
  }

  private async recoverCommand(outgoing: OutgoingCommand, changes?: Map<string, OutgoingCommand>): Promise<SentMessage> {
    if (!this.sync || !this.api.findSentMessage) throw new ClientError('Reconnect to confirm message delivery.', 'delivery_unconfirmed')
    const scope = this.sync.scope()
    const command = outgoing.command
    if (this.inFlight.has(command.client_message_id)) throw new ClientError('Message confirmation is already in progress.', 'delivery_unconfirmed')
    this.inFlight.add(command.client_message_id)
    try {
      const found = await this.api.findSentMessage(command.client_message_id)
      if (this.sync.scope() !== scope) throw new Error('Message session changed.')
      // Only an authoritative missing result permits replay, with the exact durable bytes.
      // A formerly accepted message must never become a new send.
      const accepted = found ?? (outgoing.accepted ? outgoing.accepted : await (this.realtime?.ready
        ? this.realtime.sendMessage(command) : this.api.sendMessage(command)))
      const updated = await this.sync.inbox.acceptOutgoing(scope, accepted)
      if (JSON.stringify(updated.accepted) !== JSON.stringify(outgoing.accepted)) {
        await this.outgoingChanged(updated, scope, changes)
      }
      return accepted
    } catch (error) {
      if (!outgoing.accepted && this.isDeliveryTargetsChanged(error)) {
        if (this.sync.scope() !== scope) throw new Error('Message session changed.')
        const content = await this.codec.decodeIncoming(command.envelopes[0])
        if (this.sync.scope() !== scope) throw new Error('Message session changed.')
        return await this.sendNewText(command.chat_id, content, command.client_message_id, true, changes)
      }
      throw error
    } finally {
      this.inFlight.delete(command.client_message_id)
      this.publishDeliveries()
    }
  }

  private async outgoingChanged(outgoing: OutgoingCommand, scope: InboxScope, changes?: Map<string, OutgoingCommand>): Promise<void> {
    if (changes) changes.set(outgoing.command.client_message_id, outgoing)
    else await this.publishOutgoing([outgoing], scope)
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
      chatId: command.chat_id, senderUserId: scope.userId,
      createdAt: createdAt ?? accepted?.createdAt ?? '',
      content: await this.codec.decodeIncoming(command.envelopes[0]),
      // Multi-device delivery aggregation is defined by V7. Preserve each receipt.
      ...this.deliveryState(accepted),
    }
  }

  private deliveryState(accepted: SentMessage | null): Pick<DisplayMessage, 'status' | 'deliveries'> {
    return {
      status: !accepted ? 'pending' : accepted.envelopes.length === 1 && accepted.envelopes[0].delivered_at ? 'delivered' : 'accepted',
      deliveries: accepted?.envelopes.map(item => ({ deviceId: item.recipient_device_id, deliveredAt: item.delivered_at })),
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

  private async decodeEnvelope(envelope: MailboxEnvelope): Promise<ReceivedMessage | null> {
    if (envelope.payload === null) return null
    const content = await this.codec.decodeIncoming({
      recipient_device_id: envelope.recipient_device_id,
      protocol_version: envelope.protocol_version,
      envelope_type: envelope.envelope_type,
      payload: envelope.payload,
    })
    return {
      envelopeId: envelope.id,
      historyId: `envelope:${envelope.id}`,
      messageId: envelope.message_id,
      chatId: envelope.chat_id,
      senderUserId: envelope.sender_user_id,
      senderDeviceId: envelope.sender_device_id,
      clientMessageId: envelope.client_message_id,
      mailboxSeq: envelope.mailbox_seq,
      content,
      createdAt: envelope.message_created_at,
    }
  }

  private isDeliveryTargetsChanged(error: unknown): boolean {
    return error instanceof ClientError
      && error.code === DELIVERY_TARGETS_CHANGED
  }
}
