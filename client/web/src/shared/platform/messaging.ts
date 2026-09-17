import type { IdGenerator, TextEncoding } from '@secure-messenger/client-core'

export const browserIdGenerator: IdGenerator = () => crypto.randomUUID()

export const browserTextEncoding: TextEncoding = {
  encodeUtf8: (value) => new TextEncoder().encode(value),
  decodeUtf8: (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  encodeBase64(bytes) {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  },
  decodeBase64(value) {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  },
}
