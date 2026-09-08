import {
  ApiError,
  type DestinationDevice,
  type MailboxPage,
  type SendMessageRequest,
  type SentMessage,
} from '../../../shared/api/client.ts'
import type { MessageCodec } from './messageCodec.ts'

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

  constructor(
    api: MessagingApi,
    codec: MessageCodec<string>,
    createClientMessageId: () => string = () => crypto.randomUUID(),
  ) {
    this.api = api
    this.codec = codec
    this.createClientMessageId = createClientMessageId
  }

  async sendText(chatId: string, content: string, clientMessageId?: string): Promise<SentMessage> {
    const stableClientMessageId = clientMessageId ?? this.createClientMessageId()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const destinationDevices = await this.api.getDestinationDevices(chatId)
      const envelopes = await this.codec.buildOutgoing(content, destinationDevices)

      try {
        return await this.api.sendMessage({
          chat_id: chatId,
          client_message_id: stableClientMessageId,
          envelopes,
        })
      } catch (error) {
        if (!this.isDeliveryTargetsChanged(error) || attempt === 1) throw error
      }
    }

    throw new Error('Message delivery failed.')
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

        const content = await this.codec.decodeIncoming({
          recipient_device_id: envelope.recipient_device_id,
          protocol_version: envelope.protocol_version,
          envelope_type: envelope.envelope_type,
          payload: envelope.payload,
        })
        messages.push({
          envelopeId: envelope.id,
          messageId: envelope.message_id,
          chatId: envelope.chat_id,
          senderUserId: envelope.sender_user_id,
          senderDeviceId: envelope.sender_device_id,
          clientMessageId: envelope.client_message_id,
          mailboxSeq: envelope.mailbox_seq,
          content,
          createdAt: envelope.message_created_at,
        })
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

  private isDeliveryTargetsChanged(error: unknown): boolean {
    return error instanceof ApiError
      && error.status === 409
      && error.code === DELIVERY_TARGETS_CHANGED
  }
}
