import { ClientError } from '../domain/errors.ts'
import type { ReceivedMessage, SentMessage } from '../domain/models.ts'
import type { MailboxEnvelope } from '../protocol/contracts.ts'
import type { MessagingGateway, RealtimeGateway } from '../ports/gateways.ts'
import type { IdGenerator } from '../ports/platform.ts'
import type { MessageCodec } from './messageCodec.ts'

const DELIVERY_TARGETS_CHANGED = 'delivery_targets_changed'
const MAILBOX_PAGE_SIZE = 100

export type MailboxLoadResult = {
  messages: ReceivedMessage[]
  nextSeq: number
  tombstoneCount: number
}

export class MessengerService {
  private readonly api: MessagingGateway
  private readonly codec: MessageCodec<string>
  private readonly createClientMessageId: IdGenerator
  private readonly realtime?: RealtimeGateway

  constructor(
    api: MessagingGateway,
    codec: MessageCodec<string>,
    createClientMessageId: IdGenerator,
    realtime?: RealtimeGateway,
  ) {
    this.api = api
    this.codec = codec
    this.createClientMessageId = createClientMessageId
    this.realtime = realtime
  }

  async sendText(chatId: string, content: string, clientMessageId?: string): Promise<SentMessage> {
    const stableClientMessageId = clientMessageId ?? this.createClientMessageId()

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
        return await (this.realtime?.ready
          ? this.realtime.sendMessage(command)
          : this.api.sendMessage(command))
      } catch (error) {
        if (!this.isDeliveryTargetsChanged(error) || attempt === 1) throw error
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
      void this.decodeEnvelope(envelope).then((message) => {
        if (active && message) onMessage(message)
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
    const messages: ReceivedMessage[] = []
    let tombstoneCount = 0
    let cursor = afterSeq

    while (true) {
      const page = await this.api.getMailbox(cursor, MAILBOX_PAGE_SIZE)

      for (const envelope of page.envelopes) {
        if (envelope.payload === null) {
          tombstoneCount += 1
          continue
        }

        const message = await this.decodeEnvelope(envelope)
        if (message) messages.push(message)
      }

      if (!page.hasMore) {
        return { messages, nextSeq: page.nextSeq, tombstoneCount }
      }
      if (page.nextSeq <= cursor) {
        throw new Error('Mailbox paging did not advance.')
      }
      cursor = page.nextSeq
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
