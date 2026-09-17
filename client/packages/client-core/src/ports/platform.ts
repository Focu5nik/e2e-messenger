import type { DeviceIdentity } from '../domain/models.ts'

export type IdGenerator = () => string

export type DeviceDescription = () => Promise<string>

export interface DeviceIdentityStore {
  // Return decoded, untrusted data; malformed or absent data may be null.
  read(): Promise<unknown>
  write(identity: DeviceIdentity): Promise<void>
}

export interface ChatPreferencesStore {
  getLastChatId(userId: string): Promise<string | null>
  setLastChatId(userId: string, chatId: string | null): Promise<void>
}

export interface TextEncoding {
  encodeUtf8(value: string): Uint8Array
  // Reject malformed UTF-8 instead of replacing invalid bytes.
  decodeUtf8(bytes: Uint8Array): string
  encodeBase64(bytes: Uint8Array): string
  // Reject malformed Base64.
  decodeBase64(value: string): Uint8Array
}
