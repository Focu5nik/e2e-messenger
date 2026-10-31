import { ClientError } from '../domain/errors.ts'
import type { MessageDeliveryUpdate, SentMessage } from '../domain/models.ts'
import type { InboxScope, OutgoingCommand } from '../ports/durableInbox.ts'
import type { MessagingGateway, RealtimeGateway } from '../ports/gateways.ts'
import type { IdGenerator, Scheduler } from '../ports/platform.ts'
import type { MessageEnvelope, SendMessageRequest } from '../protocol/contracts.ts'
import type { MessageCodec } from './messageCodec.ts'
import type { SyncManager } from './syncManager.ts'

const DELIVERY_TARGETS_CHANGED = 'delivery_targets_changed'

export function deliveryState(accepted: SentMessage | null): Pick<MessageDeliveryUpdate, 'status' | 'deliveries'> {
  return {
    status: !accepted ? 'pending' : accepted.envelopes.some(item => item.recipient_user_id !== accepted.senderUserId && item.delivered_at) ? 'delivered' : 'accepted',
    deliveries: accepted?.envelopes.map(item => ({ deviceId: item.recipient_device_id, deliveredAt: item.delivered_at })),
  }
}

// Owns durable sends, recovery and delivery ordering. Publication is awaited so
// UI decoding finishes before a racing delivery update reaches subscribers.
export class OutgoingManager {
  private readonly api: MessagingGateway
  private readonly codec: MessageCodec<string>
  private readonly createClientMessageId: IdGenerator
  private readonly publishOutgoing: (commands: OutgoingCommand[], scope: InboxScope) => Promise<void>
  private readonly realtime?: RealtimeGateway
  private readonly sync?: SyncManager
  private readonly scheduler?: Scheduler
  private recovering: Promise<void> | null = null
  private inFlight = new Set<string>()
  private pendingDeliveries = new Map<string, { scope: InboxScope; update: MessageDeliveryUpdate }>()
  private deliveryHandlers = new Set<(update: MessageDeliveryUpdate) => void>()

  constructor(
    api: MessagingGateway,
    codec: MessageCodec<string>,
    createClientMessageId: IdGenerator,
    publishOutgoing: (commands: OutgoingCommand[], scope: InboxScope) => Promise<void>,
    realtime?: RealtimeGateway,
    sync?: SyncManager,
    scheduler?: Scheduler,
  ) {
    this.api = api
    this.codec = codec
    this.createClientMessageId = createClientMessageId
    this.publishOutgoing = publishOutgoing
    this.realtime = realtime
    this.sync = sync
    this.scheduler = scheduler
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
      if (destinationDevices.length === 0 || (scope && destinationDevices.every(device => device.userId === scope.userId))) {
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
        const accepted = await this.sendAndConfirm(command, scope)
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

  subscribe(onError: (error: unknown) => void): () => void {
    let active = true
    const handleDeliveryReceipt = async (receipt: MessageEnvelope): Promise<void> => {
      if (!this.sync) return
      const scope = this.sync.scope()
      const outgoing = await this.sync.inbox.applyDeliveryReceipt(scope, receipt)
      if (!active || this.sync.scope() !== scope) return
      let accepted = outgoing?.accepted ?? await this.sync.inbox.getSentMetadata?.(scope, receipt.message_id)
      if (!accepted && this.api.getSentMessages) {
        await this.recoverSentMetadata(scope)
        accepted = await this.sync.inbox.getSentMetadata?.(scope, receipt.message_id)
      }
      if (!accepted || !active || this.sync.scope() !== scope) return
      this.queueDelivery(scope, accepted)
    }

    const unsubscribe = this.realtime?.onDelivered?.(receipt => {
      void handleDeliveryReceipt(receipt).catch(error => { if (active) onError(error) })
    })
    const handleAccepted = async (message: SentMessage): Promise<void> => {
      if (!this.sync) return
      const scope = this.sync.scope()
      const outgoing = await this.sync.inbox.getOutgoing(scope, message.clientMessageId)
      if (!active || this.sync.scope() !== scope || !outgoing) return
      const updated = await this.sync.inbox.acceptOutgoing(scope, message)
      if (active && this.sync.scope() === scope) await this.outgoingChanged(updated, scope)
    }
    const unsubscribeAccepted = this.realtime?.onAccepted?.(message => {
      void handleAccepted(message).catch(error => { if (active) onError(error) })
    })
    return () => { active = false; unsubscribe?.(); unsubscribeAccepted?.() }
  }

  async recoverSentMetadata(scope: InboxScope): Promise<void> {
    if (!this.sync?.inbox.mergeSentMetadata || !this.api.getSentMessages) return
    let after: string | undefined
    while (true) {
      const page = await this.api.getSentMessages(after, 100, true)
      if (this.sync.scope() !== scope) throw new Error('Message session changed.')
      for (const message of page.messages) {
        const accepted = await this.sync.inbox.mergeSentMetadata(scope, message)
        if (this.sync.scope() !== scope) throw new Error('Message session changed.')
        this.queueDelivery(scope, accepted)
      }
      if (!page.hasMore) break
      if (!page.nextMessageId || page.nextMessageId === after) throw new Error('Sent metadata paging did not advance.')
      after = page.nextMessageId
    }
  }

  private queueDelivery(scope: InboxScope, accepted: SentMessage): void {
    const update = { messageId: accepted.id, chatId: accepted.chatId, chatSeq: accepted.chatSeq, ...deliveryState(accepted) }
    this.pendingDeliveries.set(update.messageId, { scope, update })
    this.publishDeliveries()
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

  async retryOutgoing(clientMessageId: string): Promise<void> {
    if (!this.sync) return
    const scope = this.sync.scope()
    const outgoing = await this.sync.inbox.getOutgoing(scope, clientMessageId)
    if (this.sync.scope() !== scope) throw new Error('Message session changed.')
    if (outgoing) await this.recoverCommand(outgoing)
  }

  async recoverOutgoing(): Promise<void> {
    if (!this.sync || !this.api.findSentMessage) return
    if (this.recovering) return this.recovering
    const scope = this.sync.scope()
    const operation = async () => {
      const changes = new Map<string, OutgoingCommand>()
      const readStates = await this.sync!.inbox.readChatReadStates?.(scope) ?? []
      const peerReads = new Map(readStates.map(state => [state.chatId, state.peerLastReadSeq]))
      for (const outgoing of await this.sync!.inbox.getOutgoingToRecover(scope)) {
        if (this.sync!.scope() !== scope) throw new Error('Message session changed.')
        if (this.inFlight.has(outgoing.command.client_message_id)) continue
        if (outgoing.accepted?.chatSeq && outgoing.accepted.chatSeq <= (peerReads.get(outgoing.command.chat_id) ?? 0)) continue
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
      let accepted: SentMessage
      if (found !== null) {
        accepted = found
      } else if (outgoing.accepted) {
        // A formerly accepted message must never become a new send.
        accepted = outgoing.accepted
      } else {
        // Only an authoritative missing result permits replay, with the exact durable bytes.
        const latest = await this.sync.inbox.getOutgoing(scope, command.client_message_id)
        if (this.sync.scope() !== scope) throw new Error('Message session changed.')
        accepted = latest?.accepted ?? await this.sendAndConfirm(command, scope)
      }
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

  private sendCommand(command: SendMessageRequest): Promise<SentMessage> {
    if (this.realtime?.ready) return this.realtime.sendMessage(command)
    return this.api.sendMessage(command)
  }

  private async sendAndConfirm(command: SendMessageRequest, scope?: InboxScope): Promise<SentMessage> {
    try {
      return await this.sendCommand(command)
    } catch (error) {
      if (!scope || !this.sync || !this.api.findSentMessage || !this.isUnconfirmed(error)) throw error
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt && this.scheduler) {
        await new Promise<void>(resolve => { this.scheduler!.schedule(resolve, 1000 * attempt) })
      }
      if (this.sync!.scope() !== scope) throw new Error('Message session changed.')
      try {
        const local = await this.sync!.inbox.getOutgoing(scope, command.client_message_id)
        if (this.sync!.scope() !== scope) throw new Error('Message session changed.')
        if (local?.accepted) return local.accepted
        const found = await this.api.findSentMessage!(command.client_message_id)
        if (this.sync!.scope() !== scope) throw new Error('Message session changed.')
        if (found) return found
        // A late confirmation can commit while the lookup is in progress.
        const latest = await this.sync!.inbox.getOutgoing(scope, command.client_message_id)
        if (this.sync!.scope() !== scope) throw new Error('Message session changed.')
        if (latest?.accepted) return latest.accepted
        // Only authoritative absence permits replay of the exact stored bytes.
        return await this.sendCommand(command)
      } catch (error) {
        if (!this.isUnconfirmed(error)) throw error
      }
    }
    throw new ClientError('Message delivery is still unconfirmed. Retry to check its status.', 'delivery_unconfirmed')
  }

  private isUnconfirmed(error: unknown): boolean {
    return error instanceof ClientError
      && ['delivery_unconfirmed', 'network_error', 'server_error', 'invalid_response'].includes(error.code)
  }

  private async outgoingChanged(outgoing: OutgoingCommand, scope: InboxScope, changes?: Map<string, OutgoingCommand>): Promise<void> {
    if (changes) changes.set(outgoing.command.client_message_id, outgoing)
    else await this.publishOutgoing([outgoing], scope)
  }

  private isDeliveryTargetsChanged(error: unknown): boolean {
    return error instanceof ClientError
      && error.code === DELIVERY_TARGETS_CHANGED
  }
}
