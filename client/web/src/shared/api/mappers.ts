import type {
  CurrentUser, CurrentUserDto, DestinationDevice, DestinationDeviceDto, Device, DeviceDto,
  DirectChat, DirectChatDto, MailboxEnvelope, MailboxPage, MailboxPageDto,
  MessageEnvelope, SentMessage, SentMessageDto, ServerEvent, TokenResponse, User, UserDto,
} from '@secure-messenger/client-core'

function invalid(field: string): never {
  // Report the field only; response bodies can contain tokens or private data.
  throw new Error(`Invalid server response: ${field}.`)
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('object')
  return value as Record<string, unknown>
}

function string(value: unknown, field: string): string {
  return typeof value === 'string' ? value : invalid(field)
}

function integer(value: unknown, field: string): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid(field)
}

function boolean(value: unknown, field: string): boolean {
  return typeof value === 'boolean' ? value : invalid(field)
}

function timestamp(value: unknown, field: string): string {
  const text = string(value, field)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)
    || !Number.isFinite(Date.parse(text))) return invalid(field)
  return text
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : timestamp(value, field)
}

export function mapList<T>(value: unknown, map: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) return invalid('array')
  return value.map(map)
}

function validateUser(value: unknown): UserDto {
  const raw = object(value)
  return {
    id: string(raw.id, 'id'), username: string(raw.username, 'username'),
    status: string(raw.status, 'status'), created_at: timestamp(raw.created_at, 'created_at'),
  }
}

function userFromDto(dto: UserDto): User {
  return {
    id: dto.id, username: dto.username, status: dto.status, createdAt: dto.created_at,
  }
}

export function mapUser(value: unknown): User {
  return userFromDto(validateUser(value))
}

export function mapCurrentUser(value: unknown): CurrentUser {
  const raw = object(value)
  const dto: CurrentUserDto = {
    ...validateUser(raw), device_id: string(raw.device_id, 'device_id'), session_id: string(raw.session_id, 'session_id'),
  }
  return { ...userFromDto(dto), deviceId: dto.device_id, sessionId: dto.session_id }
}

export function mapDevice(value: unknown): Device {
  const raw = object(value)
  const dto: DeviceDto = {
    id: string(raw.id, 'id'), name: string(raw.name, 'name'),
    protocol_version: integer(raw.protocol_version, 'protocol_version'),
    created_at: timestamp(raw.created_at, 'created_at'),
    last_seen_at: timestamp(raw.last_seen_at, 'last_seen_at'),
    revoked_at: nullableTimestamp(raw.revoked_at, 'revoked_at'),
    is_current: boolean(raw.is_current, 'is_current'),
  }
  return {
    id: dto.id, name: dto.name, protocolVersion: dto.protocol_version,
    createdAt: dto.created_at, lastSeenAt: dto.last_seen_at,
    revokedAt: dto.revoked_at, isCurrent: dto.is_current,
  }
}

export function mapDirectChat(value: unknown): DirectChat {
  const raw = object(value)
  if (raw.type !== 'DIRECT') return invalid('type')
  const dto: DirectChatDto = {
    id: string(raw.id, 'id'), type: raw.type, created_at: timestamp(raw.created_at, 'created_at'),
    other_user: validateUser(raw.other_user),
  }
  return { id: dto.id, type: dto.type, createdAt: dto.created_at, otherUser: userFromDto(dto.other_user) }
}

export function mapDestinationDevice(value: unknown): DestinationDevice {
  const raw = object(value)
  const dto: DestinationDeviceDto = {
    id: string(raw.id, 'id'), protocol_version: integer(raw.protocol_version, 'protocol_version'),
  }
  return { id: dto.id, protocolVersion: dto.protocol_version }
}

export function mapMessageEnvelope(value: unknown): MessageEnvelope {
  const dto = object(value)
  return {
    id: string(dto.id, 'id'), message_id: string(dto.message_id, 'message_id'),
    recipient_device_id: string(dto.recipient_device_id, 'recipient_device_id'),
    mailbox_seq: integer(dto.mailbox_seq, 'mailbox_seq'),
    protocol_version: integer(dto.protocol_version, 'protocol_version'),
    envelope_type: string(dto.envelope_type, 'envelope_type'),
    payload: dto.payload === null ? null : string(dto.payload, 'payload'),
    created_at: timestamp(dto.created_at, 'created_at'),
    expires_at: timestamp(dto.expires_at, 'expires_at'),
    delivered_at: nullableTimestamp(dto.delivered_at, 'delivered_at'),
    payload_purged_at: nullableTimestamp(dto.payload_purged_at, 'payload_purged_at'),
  }
}

export function mapSentMessage(value: unknown): SentMessage {
  const raw = object(value)
  const dto: SentMessageDto = {
    id: string(raw.id, 'id'), chat_id: string(raw.chat_id, 'chat_id'),
    sender_user_id: string(raw.sender_user_id, 'sender_user_id'),
    sender_device_id: string(raw.sender_device_id, 'sender_device_id'),
    client_message_id: string(raw.client_message_id, 'client_message_id'),
    created_at: timestamp(raw.created_at, 'created_at'),
    envelopes: mapList(raw.envelopes, mapMessageEnvelope),
  }
  return {
    id: dto.id, chatId: dto.chat_id, senderUserId: dto.sender_user_id,
    senderDeviceId: dto.sender_device_id, clientMessageId: dto.client_message_id,
    createdAt: dto.created_at, envelopes: dto.envelopes,
  }
}

export function mapMailboxEnvelope(value: unknown): MailboxEnvelope {
  const dto = object(value)
  return {
    ...mapMessageEnvelope(dto), chat_id: string(dto.chat_id, 'chat_id'),
    sender_user_id: string(dto.sender_user_id, 'sender_user_id'),
    sender_device_id: string(dto.sender_device_id, 'sender_device_id'),
    client_message_id: string(dto.client_message_id, 'client_message_id'),
    message_created_at: timestamp(dto.message_created_at, 'message_created_at'),
  }
}

export function mapMailboxPage(value: unknown): MailboxPage {
  const raw = object(value)
  const dto: MailboxPageDto = {
    envelopes: mapList(raw.envelopes, mapMailboxEnvelope),
    next_seq: integer(raw.next_seq, 'next_seq'), has_more: boolean(raw.has_more, 'has_more'),
  }
  return { envelopes: dto.envelopes, nextSeq: dto.next_seq, hasMore: dto.has_more }
}

export function mapTokens(value: unknown): TokenResponse {
  const dto = object(value)
  if (dto.token_type !== 'bearer') return invalid('token_type')
  const accessToken = string(dto.access_token, 'access_token')
  const expiresIn = integer(dto.expires_in, 'expires_in')
  if (!accessToken || expiresIn === 0) return invalid('token')
  return { access_token: accessToken, token_type: dto.token_type, expires_in: expiresIn }
}

export function mapEmpty(value: unknown): void {
  if (value !== undefined) invalid('empty response')
}

export function mapError(value: unknown, fallback: string): { message: string; code: string | null } {
  const detail = value && typeof value === 'object' ? (value as Record<string, unknown>).detail : undefined
  if (typeof detail === 'string') return { message: detail, code: null }
  if (Array.isArray(detail)) {
    const messages = detail.flatMap((item: unknown) => {
      const msg = item && typeof item === 'object' ? (item as Record<string, unknown>).msg : undefined
      return typeof msg === 'string' && msg ? [msg] : []
    })
    return { message: messages.length ? messages.join('. ') : fallback, code: null }
  }
  if (detail && typeof detail === 'object') {
    const error = detail as Record<string, unknown>
    return {
      message: typeof error.message === 'string' && error.message ? error.message : fallback,
      code: typeof error.code === 'string' ? error.code : null,
    }
  }
  return { message: fallback, code: null }
}

// Validate realtime data at the same boundary as HTTP, before notifying callers.
export function mapServerEvent(value: unknown):
  | Exclude<ServerEvent, { type: 'message.accepted' | 'sync.response' }>
  | { type: 'message.accepted'; request_id: string; data: SentMessage }
  | { type: 'sync.response'; request_id: string; data: MailboxPage } {
  const dto = object(value)
  switch (dto.type) {
    case 'auth.ok': return { type: dto.type }
    case 'message.new': return { type: dto.type, data: mapMailboxEnvelope(dto.data) }
    case 'message.delivered':
      return { type: dto.type, request_id: dto.request_id === undefined ? undefined : string(dto.request_id, 'request_id'), data: mapMessageEnvelope(dto.data) }
    case 'message.accepted':
      return { type: dto.type, request_id: string(dto.request_id, 'request_id'), data: mapSentMessage(dto.data) }
    case 'sync.response':
      return { type: dto.type, request_id: string(dto.request_id, 'request_id'), data: mapMailboxPage(dto.data) }
    case 'error': {
      const error = object(dto.error)
      return {
        type: dto.type,
        request_id: dto.request_id === undefined ? undefined : string(dto.request_id, 'request_id'),
        error: { code: string(error.code, 'code'), message: string(error.message, 'message'), status: integer(error.status, 'status') },
      }
    }
    default: return invalid('event type')
  }
}
