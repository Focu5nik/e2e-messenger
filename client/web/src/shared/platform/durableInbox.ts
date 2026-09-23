import { ClientError, isDeviceIdentity } from '@secure-messenger/client-core'
import type {
  DeviceIdentity, DirectChat, DurableDeviceIdentity, DurableInbox, InboxScope,
  ChatHistoryCursor, ChatHistoryPage, InboxSnapshot, MailboxEnvelope, MessageEnvelope, OutgoingCommand, SendMessageRequest, SentMessage,
} from '@secure-messenger/client-core'

const STORES = ['identity', 'envelopes', 'outgoing', 'chats', 'cursors', 'receipts'] as const
type StoreName = typeof STORES[number]
type Stored<T> = { key: string; scope: string; value: T; pending?: string; message?: string[]; history?: string[] }

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

function indexedRecord(entry: Stored<MailboxEnvelope | OutgoingCommand>): Stored<MailboxEnvelope | OutgoingCommand> {
  const value = entry.value
  if ('command' in value) {
    return { ...entry,
      pending: !value.accepted || !value.accepted.envelopes.length || value.accepted.envelopes.some(item => !item.delivered_at) ? entry.scope : undefined,
      message: value.accepted ? [entry.scope, value.accepted.id] : undefined,
      history: [entry.scope, value.command.chat_id, value.createdAt ?? value.accepted?.createdAt ?? '', `outgoing:${value.command.client_message_id}`],
    }
  }
  return { ...entry, pending: value.payload !== null && !value.delivered_at ? entry.scope : undefined,
    history: [entry.scope, value.chat_id, value.message_created_at, `envelope:${value.id}`] }
}

function migrateSchema(database: IDBDatabase, transaction: IDBTransaction): void {
  for (const name of STORES) {
    const store = database.objectStoreNames.contains(name)
      ? transaction.objectStore(name)
      : database.createObjectStore(name, { keyPath: 'key' })
    if (name !== 'identity' && !store.indexNames.contains('scope')) store.createIndex('scope', 'scope')
    if (name === 'envelopes' || name === 'outgoing') {
      if (!store.indexNames.contains('pending')) store.createIndex('pending', 'pending')
      if (!store.indexNames.contains('history')) store.createIndex('history', 'history')
      if (name === 'outgoing' && !store.indexNames.contains('message')) store.createIndex('message', 'message', { unique: true })
      const cursor = store.openCursor()
      cursor.onsuccess = () => {
        if (!cursor.result) return
        cursor.result.update(indexedRecord(cursor.result.value))
        cursor.result.continue()
      }
    }
  }
}

function readHistoryEntries(index: IDBIndex, range: IDBKeyRange, count: number): Promise<Stored<MailboxEnvelope | OutgoingCommand>[]> {
  return new Promise((resolve, reject) => {
    const entries: Stored<MailboxEnvelope | OutgoingCommand>[] = []
    const cursor = index.openCursor(range, 'prev')
    cursor.onerror = () => reject(cursor.error)
    cursor.onsuccess = () => {
      if (!cursor.result || entries.length === count) {
        resolve(entries)
        return
      }
      entries.push(cursor.result.value)
      cursor.result.continue()
    }
  })
}

function mergeDeliveryMetadata(envelope: MessageEnvelope, prior?: MessageEnvelope): MessageEnvelope {
  return {
    ...envelope,
    delivered_at: envelope.delivered_at ?? prior?.delivered_at ?? null,
    payload_purged_at: envelope.payload_purged_at ?? prior?.payload_purged_at ?? null,
  }
}

function mergeReceipt(envelope: MessageEnvelope, receipt?: MessageEnvelope): MessageEnvelope {
  if (!receipt || receipt.message_id !== envelope.message_id || receipt.recipient_device_id !== envelope.recipient_device_id) return envelope
  return { ...envelope, delivered_at: envelope.delivered_at ?? receipt.delivered_at,
    payload_purged_at: envelope.payload_purged_at ?? receipt.payload_purged_at }
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
          this.options.databaseName ?? 'messenger.durable-inbox', 3,
        )
        let blocked = false
        opening.onupgradeneeded = () => {
          migrateSchema(opening.result, opening.transaction!)
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

  async readMetadata(scope: InboxScope): Promise<{ cursor: number; chats: DirectChat[] }> {
    return this.transaction('readonly', ['identity', 'cursors', 'chats'], async tx => {
      await this.validate(tx, scope)
      const key = scopeKey(scope)
      const [cursor, chats] = await Promise.all([
        request(tx.objectStore('cursors').get(key)) as Promise<{ value: number } | undefined>,
        request(tx.objectStore('chats').index('scope').getAll(key)) as Promise<Stored<DirectChat>[]>,
      ])
      return { cursor: cursor?.value ?? 0, chats: chats.map(entry => entry.value) }
    })
  }

  async readCursor(scope: InboxScope): Promise<number> {
    return this.transaction('readonly', ['identity', 'cursors'], async tx => {
      await this.validate(tx, scope)
      const entry = await request(tx.objectStore('cursors').get(scopeKey(scope))) as { value: number } | undefined
      return entry?.value ?? 0
    })
  }

  private async pending<T>(scope: InboxScope, store: 'envelopes' | 'outgoing'): Promise<T[]> {
    return this.transaction('readonly', ['identity', store], async tx => {
      await this.validate(tx, scope)
      const entries = await request(tx.objectStore(store).index('pending').getAll(scopeKey(scope))) as Stored<T>[]
      return entries.map(entry => entry.value)
    })
  }

  getPendingAcknowledgments(scope: InboxScope): Promise<MailboxEnvelope[]> { return this.pending(scope, 'envelopes') }
  getOutgoingToRecover(scope: InboxScope): Promise<OutgoingCommand[]> { return this.pending(scope, 'outgoing') }

  async readChatHistory(scope: InboxScope, chatId: string, limit: number, before?: ChatHistoryCursor): Promise<ChatHistoryPage> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid history page size')
    return this.transaction('readonly', ['identity', 'envelopes', 'outgoing'], async tx => {
      await this.validate(tx, scope)
      const prefix = [scopeKey(scope), chatId]
      const range = IDBKeyRange.bound(prefix, before ? [...prefix, before.createdAt, before.id] : [...prefix, []], false, true)
      const entries = (await Promise.all([
        readHistoryEntries(tx.objectStore('envelopes').index('history'), range, limit + 1),
        readHistoryEntries(tx.objectStore('outgoing').index('history'), range, limit + 1),
      ])).flat()
        .sort((a, b) => (this.options.indexedDB ?? globalThis.indexedDB).cmp(b.history!, a.history!))
      const page = entries.slice(0, limit)
      const last = page.at(-1)?.history
      return {
        envelopes: page.flatMap(entry => 'command' in entry.value ? [] : [entry.value]),
        outgoing: page.flatMap(entry => 'command' in entry.value ? [entry.value] : []),
        nextBefore: entries.length > limit && last ? { createdAt: last[2], id: last[3] } : null,
      }
    })
  }

  async applyDeliveryReceipt(scope: InboxScope, receipt: MessageEnvelope): Promise<OutgoingCommand | null> {
    if (!receipt.delivered_at) throw new Error('Invalid delivery receipt')
    return this.transaction('readwrite', ['identity', 'outgoing', 'receipts'], async tx => {
      await this.validate(tx, scope)
      const key = scopeKey(scope)
      const store = tx.objectStore('outgoing')
      const entry = await request(store.index('message').get([key, receipt.message_id])) as Stored<OutgoingCommand> | undefined
      if (!entry?.value.accepted) {
        await request(tx.objectStore('receipts').put(record(key, receipt.id, receipt)))
        return null
      }
      const accepted = entry.value.accepted
      const envelopes = accepted.envelopes.map(item => item.id === receipt.id ? mergeReceipt(item, receipt) : item)
      if (JSON.stringify(envelopes) === JSON.stringify(accepted.envelopes)) return null
      const value = { ...entry.value, accepted: { ...accepted, envelopes } }
      await request(store.put(indexedRecord({ ...entry, value })))
      return value
    })
  }

  async commitPage(scope: InboxScope, expectedCursor: number, envelopes: MailboxEnvelope[], nextCursor: number): Promise<MailboxEnvelope[]> {
    if (!Number.isSafeInteger(nextCursor) || nextCursor < expectedCursor) throw new Error('Invalid mailbox cursor')
    return this.transaction('readwrite', ['identity', 'envelopes', 'cursors'], async (tx) => {
      await this.validate(tx, scope)
      const key = scopeKey(scope)
      const cursors = tx.objectStore('cursors')
      const cursor = await request(cursors.get(key)) as { value: number } | undefined
      if ((cursor?.value ?? 0) !== expectedCursor) throw new Error('Mailbox cursor changed')
      const store = tx.objectStore('envelopes')
      const changes: MailboxEnvelope[] = []
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
        if (JSON.stringify(existing?.value) !== JSON.stringify(entry.value)) {
          await request(store.put(indexedRecord(entry)))
          changes.push(entry.value)
        }
      }
      await request(cursors.put({ key, scope: key, value: nextCursor }))
      return changes
    })
  }

  async getOutgoing(scope: InboxScope, clientMessageId: string): Promise<OutgoingCommand | null> {
    return this.transaction('readonly', ['identity', 'outgoing'], async (tx) => {
      await this.validate(tx, scope)
      const key = record(scopeKey(scope), clientMessageId, null).key
      const entry = await request(tx.objectStore('outgoing').get(key)) as Stored<OutgoingCommand> | undefined
      return entry?.value ?? null
    })
  }

  async putOutgoing(scope: InboxScope, command: SendMessageRequest, replaceRejected = false): Promise<OutgoingCommand> {
    const immutableCommand = structuredClone(command)
    return this.transaction('readwrite', ['identity', 'outgoing'], async (tx) => {
      await this.validate(tx, scope)
      const store = tx.objectStore('outgoing')
      const entry = record<OutgoingCommand>(scopeKey(scope), immutableCommand.client_message_id, { command: immutableCommand, accepted: null, createdAt: new Date().toISOString() })
      const existing = await request(store.get(entry.key)) as Stored<OutgoingCommand> | undefined
      if (existing && replaceRejected) {
        if (existing.value.accepted) throw new Error('Accepted outgoing command cannot be replaced')
        if (existing.value.command.chat_id !== immutableCommand.chat_id) throw new Error('Outgoing command belongs to another chat')
        entry.value.createdAt = existing.value.createdAt ?? ''
      } else if (existing) {
        if (JSON.stringify(existing.value.command) !== JSON.stringify(immutableCommand)) throw new Error('Outgoing command is immutable')
        return existing.value
      }
      await request(store.put(indexedRecord(entry)))
      return entry.value
    })
  }

  async acceptOutgoing(scope: InboxScope, message: SentMessage): Promise<OutgoingCommand> {
    return this.transaction('readwrite', ['identity', 'outgoing', 'receipts'], async (tx) => {
      await this.validate(tx, scope)
      if (message.senderDeviceId !== scope.deviceId || message.senderUserId !== scope.userId) {
        throw new Error('Accepted message belongs to another sender')
      }
      const store = tx.objectStore('outgoing')
      const key = record(scopeKey(scope), message.clientMessageId, null).key
      const existing = await request(store.get(key)) as Stored<OutgoingCommand> | undefined
      if (!existing) throw new Error('Missing durable outgoing command')
      if (existing.value.command.chat_id !== message.chatId) throw new Error('Accepted message belongs to another chat')
      const previousAcceptance = existing.value.accepted
      const createdAt = existing.value.createdAt ?? previousAcceptance?.createdAt ?? ''
      const envelopes: MessageEnvelope[] = []
      const receipts = tx.objectStore('receipts')
      for (const envelope of message.envelopes) {
        const prior = previousAcceptance?.envelopes.find(item => item.id === envelope.id)
        const envelopeWithMetadata = mergeDeliveryMetadata(envelope, prior)
        const receiptKey = record(scopeKey(scope), envelope.id, null).key
        const receipt = await request(receipts.get(receiptKey)) as Stored<MessageEnvelope> | undefined
        envelopes.push(mergeReceipt(envelopeWithMetadata, receipt?.value))
        await request(receipts.delete(receiptKey))
      }
      const accepted: SentMessage = { ...message, envelopes }
      const value: OutgoingCommand = { ...existing.value, createdAt, accepted }
      await request(store.put(indexedRecord({ ...existing, value })))
      return value
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
