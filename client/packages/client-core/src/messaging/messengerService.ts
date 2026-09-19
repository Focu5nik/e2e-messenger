import { ClientError } from '../domain/errors.ts'
import type { DirectChat, DisplayMessage, ReceivedMessage, SentMessage } from '../domain/models.ts'
import type { InboxSnapshot } from '../ports/durableInbox.ts'
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
        if (scope) await this.sync!.inbox.putOutgoing(scope, command)
        if (scope && this.sync!.scope() !== scope) throw new Error('Message session changed.')
        const accepted = await (this.realtime?.ready
          ? this.realtime.sendMessage(command)
          : this.api.sendMessage(command))
        if (scope) await this.sync!.inbox.acceptOutgoing(scope, accepted)
        return accepted
      } catch (error) {
        if (!this.isDeliveryTargetsChanged(error)) throw error
        if (scope) await this.sync!.inbox.rejectOutgoing(scope, stableClientMessageId)
        if (attempt === 1) throw error
      }
    }

    throw new Error('Message delivery failed.')
  }

  subscribe(
    onMessage: (message: ReceivedMessage) => void,
    onError: (error: unknown) => void,
  ): () => void {
    let active = true
    const unsubscribe = this.realtime?.onMessage((envelope) => {
      const incoming = this.sync
        ? this.sync.ingest(envelope).then(async (snapshot) => {
          const messages = await Promise.all(snapshot.envelopes.map((item) => this.decodeEnvelope(item)))
          return messages.filter((message): message is ReceivedMessage => message !== null)
        })
        : this.decodeEnvelope(envelope).then((message) => message ? [message] : [])
      void incoming.then((messages) => {
        if (active) for (const message of messages) onMessage(message)
      }).catch((error: unknown) => {
        if (active) onError(error)
      })
    })
    return () => { active = false; unsubscribe?.() }
  }

  onReady(handler: () => void): () => void {
    return this.realtime?.onReady(handler) ?? (() => {})
  }

  async loadMailbox(afterSeq = 0): Promise<MailboxLoadResult> {
    if (this.sync) return this.decodeSnapshot(await this.sync.synchronize())
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

  async restoreLocal(): Promise<MailboxLoadResult & { chats: DirectChat[] }> {
    if (!this.sync) return { messages: [], envelopes: [], nextSeq: 0, tombstoneCount: 0, chats: [] }
    const snapshot = await this.sync.snapshot()
    return { ...await this.decodeSnapshot(snapshot), chats: snapshot.chats }
  }

  async cacheChats(chats: DirectChat[]): Promise<void> {
    if (this.sync) await this.sync.inbox.saveChats(this.sync.scope(), chats)
  }

  private async decodeSnapshot(snapshot: InboxSnapshot): Promise<MailboxLoadResult> {
    const messages: DisplayMessage[] = []
    for (const envelope of snapshot.envelopes) {
      const message = await this.decodeEnvelope(envelope)
      if (message) messages.push(message)
    }
    for (const { command, accepted } of snapshot.outgoing) {
      if (!accepted || !command.envelopes[0]) continue
      messages.push({
        messageId: accepted.id, chatId: accepted.chatId, senderUserId: accepted.senderUserId,
        createdAt: accepted.createdAt, content: await this.codec.decodeIncoming(command.envelopes[0]),
      })
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
