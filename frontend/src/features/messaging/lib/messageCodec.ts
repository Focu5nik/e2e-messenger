import type { ClientEnvelope, DestinationDevice } from '../../../shared/api/client.ts'

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

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export class PlaintextMessageCodec implements MessageCodec<string> {
  async buildOutgoing(
    logicalContent: string,
    destinationDevices: readonly DestinationDevice[],
  ): Promise<ClientEnvelope[]> {
    const payload = encodeBase64(new TextEncoder().encode(logicalContent))

    return destinationDevices.map((device) => {
      if (device.protocol_version !== PLAINTEXT_PROTOCOL_VERSION) {
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
      return new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(envelope.payload))
    } catch {
      throw new Error('The message payload is not valid UTF-8 plaintext.')
    }
  }
}
