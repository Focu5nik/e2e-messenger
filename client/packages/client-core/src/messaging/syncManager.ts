import type { CurrentUser, MailboxPage } from '../domain/models.ts'
import type { DurableInbox, InboxScope, InboxSnapshot } from '../ports/durableInbox.ts'
import type { MessagingGateway, RealtimeGateway } from '../ports/gateways.ts'
import type { MailboxEnvelope } from '../protocol/contracts.ts'

type SyncChanges = { cursor: number; envelopes: MailboxEnvelope[] }

export class SyncManager {
  readonly inbox: DurableInbox
  private readonly api: Pick<MessagingGateway, 'getMailbox' | 'acknowledgeEnvelope'>
  private readonly realtime?: RealtimeGateway
  private current: InboxScope | null = null
  private pending: Promise<unknown> = Promise.resolve()
  private revision = 0

  constructor(
    inbox: DurableInbox,
    api: Pick<MessagingGateway, 'getMailbox' | 'acknowledgeEnvelope'>,
    realtime?: RealtimeGateway,
  ) { this.inbox = inbox; this.api = api; this.realtime = realtime }

  async activate(user: CurrentUser): Promise<void> {
    const revision = ++this.revision
    this.current = null
    const identity = await this.inbox.read()
    if (!identity || identity.id !== user.deviceId) throw new Error('Local message storage was reset. Please sign in again.')
    if (revision !== this.revision) return
    this.current = { userId: user.id, deviceId: identity.id, generation: identity.generation }
  }

  deactivate(): void { this.revision += 1; this.current = null }

  scope(): InboxScope {
    if (!this.current) throw new Error('Local message storage is not ready. Please sign in again.')
    return this.current
  }

  snapshot(): Promise<InboxSnapshot> { return this.inbox.snapshot(this.scope()) }

  synchronize(): Promise<SyncChanges> {
    const scope = this.scope()
    return this.enqueue(async () => {
      const changes = new Map<string, MailboxEnvelope>()
      await this.acknowledgePending(scope, changes)
      await this.pageMailbox(scope, changes)
      return { cursor: await this.inbox.readCursor(scope), envelopes: [...changes.values()] }
    })
  }

  ingest(envelope: MailboxEnvelope): Promise<SyncChanges> {
    const scope = this.scope()
    return this.enqueue(async () => {
      this.assertCurrent(scope)
      if (envelope.recipient_device_id !== scope.deviceId) throw new Error('Mailbox envelope belongs to a different device.')
      if (!Number.isSafeInteger(envelope.mailbox_seq) || envelope.mailbox_seq < 1) throw new Error('Invalid mailbox sequence.')
      const changes = new Map<string, MailboxEnvelope>()
      let cursor = await this.inbox.readCursor(scope)
      if (envelope.mailbox_seq > cursor + 1) {
        // Realtime delivery can race/reorder. PostgreSQL explains every missing
        // sequence (including tombstones) before the local cursor can advance.
        await this.pageMailbox(scope, changes)
        cursor = await this.inbox.readCursor(scope)
      }
      if (envelope.mailbox_seq > cursor + 1) throw new Error('Mailbox sequence gap; sync stopped.')
      this.assertCurrent(scope)
      this.collect(changes, await this.inbox.commitPage(scope, cursor, [envelope], Math.max(cursor, envelope.mailbox_seq)))
      await this.acknowledgePending(scope, changes)
      return { cursor: await this.inbox.readCursor(scope), envelopes: [...changes.values()] }
    })
  }

  private async pageMailbox(scope: InboxScope, changes: Map<string, MailboxEnvelope>): Promise<void> {
    while (true) {
      this.assertCurrent(scope)
      const cursor = await this.inbox.readCursor(scope)
      const page = this.realtime?.ready && this.realtime.getMailbox
        ? await this.realtime.getMailbox(cursor, 100)
        : await this.api.getMailbox(cursor, 100)
      this.assertCurrent(scope)
      this.validatePage(scope, cursor, page)
      this.collect(changes, await this.inbox.commitPage(scope, cursor, page.envelopes, page.nextSeq))
      await this.acknowledgePending(scope, changes)
      if (!page.hasMore) return
    }
  }

  private async acknowledgePending(scope: InboxScope, changes: Map<string, MailboxEnvelope>): Promise<void> {
    const gateway = this.realtime?.ready && this.realtime.acknowledgeEnvelope ? this.realtime : this.api
    if (!gateway.acknowledgeEnvelope) return
    const pending = await this.inbox.getPendingAcknowledgments(scope)
    for (const envelope of pending) {
      if (envelope.payload === null || envelope.delivered_at !== null) continue
      this.assertCurrent(scope)
      let receipt
      try { receipt = await gateway.acknowledgeEnvelope(envelope.id) }
      catch {
        // Delivery is already durable. An unavailable ACK transport must not hide
        // local messages; the missing delivered_at retries on the next sync.
        this.assertCurrent(scope)
        continue
      }
      this.assertCurrent(scope)
      if (receipt.id !== envelope.id || receipt.message_id !== envelope.message_id
        || receipt.recipient_device_id !== scope.deviceId || !receipt.delivered_at) {
        throw new Error('Invalid delivery receipt.')
      }
      const cursor = await this.inbox.readCursor(scope)
      // Persist the receipt only; server purge must never erase the local payload.
      try { this.collect(changes, await this.inbox.commitPage(scope, cursor, [{ ...envelope, ...receipt, payload: envelope.payload }], cursor)) }
      catch { this.assertCurrent(scope) } // Lost receipt commit is safe to retry idempotently.
    }
  }

  private collect(changes: Map<string, MailboxEnvelope>, envelopes: MailboxEnvelope[]): void {
    for (const envelope of envelopes) changes.set(envelope.id, envelope)
  }

  private validatePage(scope: InboxScope, cursor: number, page: MailboxPage): void {
    let expected = cursor
    for (const envelope of page.envelopes) {
      if (envelope.recipient_device_id !== scope.deviceId
        || !Number.isSafeInteger(envelope.mailbox_seq) || envelope.mailbox_seq !== ++expected) {
        throw new Error('Mailbox sequence gap or invalid device; sync stopped.')
      }
    }
    if (page.nextSeq !== expected || (page.hasMore && expected === cursor)) {
      throw new Error('Mailbox cursor does not match the persisted page; sync stopped.')
    }
  }

  private assertCurrent(scope: InboxScope): void {
    if (this.current !== scope) throw new Error('Mailbox session changed; sync stopped.')
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => {})
    return result
  }
}
