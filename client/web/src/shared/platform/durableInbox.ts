import { ClientError, isDeviceIdentity } from '@secure-messenger/client-core'
import type {
  DeviceIdentity, DirectChat, DurableDeviceIdentity, DurableInbox, InboxScope,
  InboxSnapshot, MailboxEnvelope, OutgoingCommand, SendMessageRequest, SentMessage,
} from '@secure-messenger/client-core'

const STORES = ['identity', 'envelopes', 'outgoing', 'chats', 'cursors'] as const
type StoreName = typeof STORES[number]
type Stored<T> = { key: string; scope: string; value: T }

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error ?? new Error('IndexedDB request failed'))
  })
}

function scopeKey(scope: InboxScope): string {
  return JSON.stringify([scope.userId, scope.deviceId, scope.generation])
}

function record<T>(scope: string, id: string, value: T): Stored<T> {
  return { key: JSON.stringify([scope, id]), scope, value }
}

// This adapter stores opaque protocol payloads only. Decoding belongs in core.
export class IndexedDBDurableInbox implements DurableInbox {
  private database: Promise<IDBDatabase> | undefined
  private observedGeneration: string | null = null
  private readonly options: { indexedDB?: IDBFactory; databaseName?: string }

  constructor(options: { indexedDB?: IDBFactory; databaseName?: string } = {}) {
    this.options = options
  }

  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        const opening = (this.options.indexedDB ?? globalThis.indexedDB).open(
          this.options.databaseName ?? 'messenger.durable-inbox', 1,
        )
        let blocked = false
        opening.onupgradeneeded = () => {
          for (const name of STORES) {
            const store = opening.result.createObjectStore(name, { keyPath: 'key' })
            if (name !== 'identity') store.createIndex('scope', 'scope')
          }
        }
        opening.onsuccess = () => {
          const db = opening.result
          if (blocked) { db.close(); return }
          db.onversionchange = () => { db.close(); this.database = undefined }
          db.onclose = () => { this.database = undefined }
          resolve(db)
        }
        opening.onerror = () => reject(opening.error ?? new Error('IndexedDB open failed'))
        opening.onblocked = () => { blocked = true; reject(new Error('IndexedDB upgrade blocked')) }
      }).catch((error: unknown) => { this.database = undefined; throw error })
    }
    return this.database
  }

  private async transaction<T>(
    mode: IDBTransactionMode,
    stores: StoreName[],
    operation: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const db = await this.open()
    const transaction = db.transaction(stores, mode, { durability: mode === 'readwrite' ? 'strict' : 'default' })
    const complete = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
      transaction.onerror = () => { /* onabort reports the transaction outcome. */ }
    })
    // A request can fail before the operation has finished unwinding.
    void complete.catch(() => {})
    try {
      const result = await operation(transaction)
      await complete
      return result
    } catch (error) {
      try { transaction.abort() } catch { /* Already completed or aborted. */ }
      await complete.catch(() => {})
      throw error
    }
  }

  private async identity(transaction: IDBTransaction): Promise<DurableDeviceIdentity | null> {
    const stored = await request(transaction.objectStore('identity').get('current')) as
      { key: string; value: DurableDeviceIdentity } | undefined
    const identity = stored?.value
    return isDeviceIdentity(identity) && typeof identity.generation === 'string' && identity.generation.length > 0
      ? identity : null
  }

  private async validate(transaction: IDBTransaction, scope: InboxScope): Promise<void> {
    const identity = await this.identity(transaction)
    if (!identity || identity.id !== scope.deviceId || identity.generation !== scope.generation) {
      throw new ClientError('Local device generation changed', 'local_generation_changed')
    }
  }

  private removeLegacyIdentity(): void {
    // V4's localStorage identity must never select the durable mailbox. A browser
    // denying localStorage does not prevent using the committed IndexedDB identity.
    try { globalThis.localStorage?.removeItem('messenger.device') } catch { /* Unavailable. */ }
  }

  async read(): Promise<DurableDeviceIdentity | null> {
    const identity = await this.transaction('readonly', ['identity'], (tx) => this.identity(tx))
    this.observedGeneration = identity?.generation ?? null
    if (identity) this.removeLegacyIdentity()
    return identity
  }

  async write(identity: DeviceIdentity): Promise<void> {
    const expectedGeneration = this.observedGeneration
    const generation = globalThis.crypto.randomUUID()
    await this.transaction('readwrite', [...STORES], async (tx) => {
      const current = await this.identity(tx)
      if ((current?.generation ?? null) !== expectedGeneration) {
        throw new ClientError('Local device generation changed', 'local_generation_changed')
      }
      for (const name of STORES) tx.objectStore(name).clear()
      await request(tx.objectStore('identity').put({ key: 'current', value: { ...identity, generation } }))
    })
    this.observedGeneration = generation
    this.removeLegacyIdentity()
  }

  async snapshot(scope: InboxScope): Promise<InboxSnapshot> {
    return this.transaction('readonly', [...STORES], async (tx) => {
      await this.validate(tx, scope)
      const key = scopeKey(scope)
      const [cursor, envelopes, outgoing, chats] = await Promise.all([
        request(tx.objectStore('cursors').get(key)) as Promise<{ value: number } | undefined>,
        request(tx.objectStore('envelopes').index('scope').getAll(key)) as Promise<Stored<MailboxEnvelope>[]>,
        request(tx.objectStore('outgoing').index('scope').getAll(key)) as Promise<Stored<OutgoingCommand>[]>,
        request(tx.objectStore('chats').index('scope').getAll(key)) as Promise<Stored<DirectChat>[]>,
      ])
      return {
        cursor: cursor?.value ?? 0,
        envelopes: envelopes.map((entry) => entry.value).sort((a, b) => a.mailbox_seq - b.mailbox_seq),
        outgoing: outgoing.map((entry) => entry.value),
        chats: chats.map((entry) => entry.value),
      }
    })
  }

  async commitPage(scope: InboxScope, expectedCursor: number, envelopes: MailboxEnvelope[], nextCursor: number): Promise<void> {
    if (!Number.isSafeInteger(nextCursor) || nextCursor < expectedCursor) throw new Error('Invalid mailbox cursor')
    await this.transaction('readwrite', ['identity', 'envelopes', 'cursors'], async (tx) => {
      await this.validate(tx, scope)
      const key = scopeKey(scope)
      const cursors = tx.objectStore('cursors')
      const cursor = await request(cursors.get(key)) as { value: number } | undefined
      if ((cursor?.value ?? 0) !== expectedCursor) throw new Error('Mailbox cursor changed')
      const store = tx.objectStore('envelopes')
      for (const envelope of envelopes) {
        if (envelope.recipient_device_id !== scope.deviceId) throw new Error('Envelope belongs to another device')
        const entry = record(key, envelope.id, envelope)
        const existing = await request(store.get(entry.key)) as Stored<MailboxEnvelope> | undefined
        // Server expiry changes metadata; it must not delete a received local copy.
        entry.value = {
          ...envelope,
          payload: envelope.payload ?? existing?.value.payload ?? null,
          delivered_at: envelope.delivered_at ?? existing?.value.delivered_at ?? null,
          payload_purged_at: envelope.payload_purged_at ?? existing?.value.payload_purged_at ?? null,
        }
        await request(store.put(entry))
      }
      await request(cursors.put({ key, scope: key, value: nextCursor }))
    })
  }

  async putOutgoing(scope: InboxScope, command: SendMessageRequest): Promise<void> {
    const immutableCommand = structuredClone(command)
    await this.transaction('readwrite', ['identity', 'outgoing'], async (tx) => {
      await this.validate(tx, scope)
      const store = tx.objectStore('outgoing')
      const entry = record<OutgoingCommand>(scopeKey(scope), immutableCommand.client_message_id, { command: immutableCommand, accepted: null })
      const existing = await request(store.get(entry.key)) as Stored<OutgoingCommand> | undefined
      if (existing) {
        if (JSON.stringify(existing.value.command) !== JSON.stringify(immutableCommand)) throw new Error('Outgoing command is immutable')
        return
      }
      await request(store.put(entry))
    })
  }

  async rejectOutgoing(scope: InboxScope, clientMessageId: string): Promise<void> {
    await this.transaction('readwrite', ['identity', 'outgoing'], async (tx) => {
      await this.validate(tx, scope)
      const store = tx.objectStore('outgoing')
      const key = record(scopeKey(scope), clientMessageId, null).key
      const existing = await request(store.get(key)) as Stored<OutgoingCommand> | undefined
      if (existing?.value.accepted) throw new Error('Accepted outgoing command cannot be rejected')
      await request(store.delete(key))
    })
  }

  async acceptOutgoing(scope: InboxScope, message: SentMessage): Promise<void> {
    await this.transaction('readwrite', ['identity', 'outgoing'], async (tx) => {
      await this.validate(tx, scope)
      if (message.senderDeviceId !== scope.deviceId || message.senderUserId !== scope.userId) {
        throw new Error('Accepted message belongs to another sender')
      }
      const store = tx.objectStore('outgoing')
      const key = record(scopeKey(scope), message.clientMessageId, null).key
      const existing = await request(store.get(key)) as Stored<OutgoingCommand> | undefined
      if (!existing) throw new Error('Missing durable outgoing command')
      if (existing.value.command.chat_id !== message.chatId) throw new Error('Accepted message belongs to another chat')
      await request(store.put({ ...existing, value: { ...existing.value, accepted: message } }))
    })
  }

  async saveChats(scope: InboxScope, chats: DirectChat[]): Promise<void> {
    await this.transaction('readwrite', ['identity', 'chats'], async (tx) => {
      await this.validate(tx, scope)
      const key = scopeKey(scope)
      for (const chat of chats) await request(tx.objectStore('chats').put(record(key, chat.id, chat)))
    })
  }
}

export const browserDurableInbox = new IndexedDBDurableInbox()
