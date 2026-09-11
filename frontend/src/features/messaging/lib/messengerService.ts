import {
  ApiError,
  type DestinationDevice,
  type MailboxPage,
  type MailboxEnvelope,
  type SendMessageRequest,
  type SentMessage,
} from '../../../shared/api/client.ts'
import type { MessageCodec } from './messageCodec.ts'
import type { RealtimeTransport } from '../../../shared/api/webSocketManager.ts'

const DELIVERY_TARGETS_CHANGED = 'delivery_targets_changed'
const MAILBOX_PAGE_SIZE = 100

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

export type MailboxLoadResult = {
  messages: ReceivedMessage[]
  nextSeq: number
  tombstoneCount: number
}

export interface MessagingApi {
  getDestinationDevices(chatId: string): Promise<DestinationDevice[]>
  sendMessage(command: SendMessageRequest): Promise<SentMessage>
  getMailbox(afterSeq: number, limit?: number): Promise<MailboxPage>
}

export class MessengerService {
  private readonly api: MessagingApi
  private readonly codec: MessageCodec<string>
  private readonly createClientMessageId: () => string
  private readonly realtime?: RealtimeTransport

  constructor(
    api: MessagingApi,
    codec: MessageCodec<string>,
    createClientMessageId: () => string = () => crypto.randomUUID(),
    realtime?: RealtimeTransport,
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

      if (!page.has_more) {
        return { messages, nextSeq: page.next_seq, tombstoneCount }
      }
      if (page.next_seq <= cursor) {
        throw new Error('Mailbox paging did not advance.')
      }
      cursor = page.next_seq
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
    return error instanceof ApiError
      && error.status === 409
      && error.code === DELIVERY_TARGETS_CHANGED
  }
}
