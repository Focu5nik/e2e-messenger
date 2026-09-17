// Backend JSON contracts. Envelope field names are part of the V3/V4 protocol.
export type CredentialsRequest = { username: string; password: string }
export type LoginRequest = CredentialsRequest & { device_id: string; device_name: string }
export type TokenResponse = { access_token: string; token_type: 'bearer'; expires_in: number }

export type UserDto = {
  id: string
  username: string
  status: string
  created_at: string
}

export type CurrentUserDto = UserDto & { device_id: string; session_id: string }

export type DeviceDto = {
  id: string
  name: string
  protocol_version: number
  created_at: string
  last_seen_at: string
  revoked_at: string | null
  is_current: boolean
}

export type DirectChatDto = {
  id: string
  type: 'DIRECT'
  created_at: string
  other_user: UserDto
}

export type DestinationDeviceDto = { id: string; protocol_version: number }

export type ClientEnvelope = {
  recipient_device_id: string
  protocol_version: number
  envelope_type: string
  payload: string
}

export type SendMessageRequest = {
  chat_id: string
  client_message_id: string
  envelopes: ClientEnvelope[]
}

export type MessageEnvelope = Omit<ClientEnvelope, 'payload'> & {
  id: string
  message_id: string
  mailbox_seq: number
  payload: string | null
  created_at: string
  expires_at: string
  delivered_at: string | null
  payload_purged_at: string | null
}

export type SentMessageDto = {
  id: string
  chat_id: string
  sender_user_id: string
  sender_device_id: string
  client_message_id: string
  created_at: string
  envelopes: MessageEnvelope[]
}

export type MailboxEnvelope = MessageEnvelope & {
  chat_id: string
  sender_user_id: string
  sender_device_id: string
  client_message_id: string
  message_created_at: string
}

export type MailboxPageDto = { envelopes: MailboxEnvelope[]; next_seq: number; has_more: boolean }

export type ErrorDetail =
  | string
  | Array<{ loc?: Array<string | number>; msg?: string; type?: string }>
  | { code?: string; message?: string }
export type ErrorResponse = { detail?: ErrorDetail }

export type ServerEvent =
  | { type: 'auth.ok' }
  | { type: 'message.new'; data: MailboxEnvelope }
  | { type: 'message.accepted'; request_id: string; data: SentMessageDto }
  | { type: 'error'; request_id?: string; error: { code: string; message: string; status: number } }

export type ClientEvent =
  | { type: 'auth'; access_token: string }
  | { type: 'message.send'; request_id: string; data: SendMessageRequest }
