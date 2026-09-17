import type { DestinationDevice } from '../domain/models.ts'
import type { ClientEnvelope } from '../protocol/contracts.ts'
import type { TextEncoding } from '../ports/platform.ts'

export type IncomingEnvelope = Pick<
  ClientEnvelope,
  'recipient_device_id' | 'protocol_version' | 'envelope_type' | 'payload'
>

export interface MessageCodec<LogicalContent> {
  buildOutgoing(
    logicalContent: LogicalContent,
    destinationDevices: readonly DestinationDevice[],
  ): Promise<ClientEnvelope[]>

  decodeIncoming(envelope: IncomingEnvelope): Promise<LogicalContent>
}

const PLAINTEXT_PROTOCOL_VERSION = 0
const PLAINTEXT_ENVELOPE_TYPE = 'PLAINTEXT'

export class PlaintextMessageCodec implements MessageCodec<string> {
  private readonly encoding: TextEncoding

  constructor(encoding: TextEncoding) {
    this.encoding = encoding
  }

  async buildOutgoing(
    logicalContent: string,
    destinationDevices: readonly DestinationDevice[],
  ): Promise<ClientEnvelope[]> {
    const payload = this.encoding.encodeBase64(this.encoding.encodeUtf8(logicalContent))

    return destinationDevices.map((device) => {
      if (device.protocolVersion !== PLAINTEXT_PROTOCOL_VERSION) {
        throw new Error(`Device ${device.id} does not support plaintext messaging.`)
      }

      return {
        recipient_device_id: device.id,
        protocol_version: PLAINTEXT_PROTOCOL_VERSION,
        envelope_type: PLAINTEXT_ENVELOPE_TYPE,
        payload,
      }
    })
  }

  async decodeIncoming(envelope: IncomingEnvelope): Promise<string> {
    if (
      envelope.protocol_version !== PLAINTEXT_PROTOCOL_VERSION
      || envelope.envelope_type !== PLAINTEXT_ENVELOPE_TYPE
    ) {
      throw new Error(
        `Unsupported message envelope: ${envelope.protocol_version}/${envelope.envelope_type}.`,
      )
    }

    try {
      return this.encoding.decodeUtf8(this.encoding.decodeBase64(envelope.payload))
    } catch {
      throw new Error('The message payload is not valid UTF-8 plaintext.')
    }
  }
}
