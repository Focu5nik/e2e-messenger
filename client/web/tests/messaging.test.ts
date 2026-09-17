import assert from 'node:assert/strict'
import test from 'node:test'
import { PlaintextMessageCodec } from '@secure-messenger/client-core'
import { browserIdGenerator, browserTextEncoding } from '../src/shared/platform/messaging.ts'

const codec = new PlaintextMessageCodec(browserTextEncoding)

test('browser encoding preserves the plaintext wire format for Unicode and empty messages', async () => {
  for (const content of ['', 'Hello, Bob \u{1F30D}', '\u041F\u0440\u0438\u0432\u0435\u0442', 'a'.repeat(100_000)]) {
    const [envelope] = await codec.buildOutgoing(content, [{ id: 'device-1', protocolVersion: 0 }])
    assert.equal(envelope.payload, Buffer.from(content, 'utf8').toString('base64'))
    assert.equal(await codec.decodeIncoming(envelope), content)
  }
})

test('browser decoding rejects malformed Base64 and invalid UTF-8', async () => {
  for (const payload of ['%%%', 'a', '/w==', 'wyg=']) {
    await assert.rejects(codec.decodeIncoming({
      recipient_device_id: 'device-1', protocol_version: 0, envelope_type: 'PLAINTEXT', payload,
    }), /not valid UTF-8 plaintext/)
  }
})

test('browser ID generation produces UUIDs for client messages', () => {
  const first = browserIdGenerator()
  const second = browserIdGenerator()
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(first, second)
})
