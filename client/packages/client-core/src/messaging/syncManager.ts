import type { CurrentUser, MailboxPage } from '../domain/models.ts'
import type { DurableInbox, InboxScope, InboxSnapshot } from '../ports/durableInbox.ts'
import type { MessagingGateway, RealtimeGateway } from '../ports/gateways.ts'
import type { MailboxEnvelope } from '../protocol/contracts.ts'

export class SyncManager {
  readonly inbox: DurableInbox
  private readonly api: Pick<MessagingGateway, 'getMailbox'>
  private readonly realtime?: RealtimeGateway
  private current: InboxScope | null = null
  private pending: Promise<unknown> = Promise.resolve()
  private revision = 0

  constructor(
    inbox: DurableInbox,
    api: Pick<MessagingGateway, 'getMailbox'>,
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

  synchronize(): Promise<InboxSnapshot> {
    const scope = this.scope()
    return this.enqueue(async () => {
      await this.pageMailbox(scope)
      return this.inbox.snapshot(scope)
    })
  }

  ingest(envelope: MailboxEnvelope): Promise<InboxSnapshot> {
    const scope = this.scope()
    return this.enqueue(async () => {
      this.assertCurrent(scope)
      if (envelope.recipient_device_id !== scope.deviceId) throw new Error('Mailbox envelope belongs to a different device.')
      if (!Number.isSafeInteger(envelope.mailbox_seq) || envelope.mailbox_seq < 1) throw new Error('Invalid mailbox sequence.')
      let snapshot = await this.inbox.snapshot(scope)
      if (envelope.mailbox_seq > snapshot.cursor + 1) {
        // Realtime delivery can race/reorder. PostgreSQL explains every missing
        // sequence (including tombstones) before the local cursor can advance.
        await this.pageMailbox(scope)
        snapshot = await this.inbox.snapshot(scope)
      }
      if (envelope.mailbox_seq > snapshot.cursor + 1) throw new Error('Mailbox sequence gap; sync stopped.')
      this.assertCurrent(scope)
      await this.inbox.commitPage(scope, snapshot.cursor, [envelope], Math.max(snapshot.cursor, envelope.mailbox_seq))
      return this.inbox.snapshot(scope)
    })
  }

  private async pageMailbox(scope: InboxScope): Promise<void> {
    while (true) {
      this.assertCurrent(scope)
      const { cursor } = await this.inbox.snapshot(scope)
      const page = this.realtime?.ready && this.realtime.getMailbox
        ? await this.realtime.getMailbox(cursor, 100)
        : await this.api.getMailbox(cursor, 100)
      this.assertCurrent(scope)
      this.validatePage(scope, cursor, page)
      await this.inbox.commitPage(scope, cursor, page.envelopes, page.nextSeq)
      if (!page.hasMore) return
    }
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
