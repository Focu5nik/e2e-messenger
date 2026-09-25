import type { ChatReadCursor, ChatReadState } from '../domain/models.ts'
import type { MessagingGateway, RealtimeGateway } from '../ports/gateways.ts'
import type { InboxScope } from '../ports/durableInbox.ts'
import type { Scheduler } from '../ports/platform.ts'
import type { SyncManager } from './syncManager.ts'

// Durable state is authoritative; notifications and responses can arrive in any order.
export class ReadCursorManager {
  private states = new Map<string, ChatReadState>()
  private current: InboxScope | null = null
  private handlers = new Set<(state: ChatReadState) => void>()
  private cancel: (() => void) | undefined
  private inFlight = new Set<string>()
  private stopped = false
  private readonly sync: SyncManager
  private readonly api: MessagingGateway
  private readonly realtime?: RealtimeGateway
  private readonly scheduler?: Scheduler
  constructor(sync: SyncManager, api: MessagingGateway, realtime?: RealtimeGateway, scheduler?: Scheduler) {
    this.sync = sync; this.api = api; this.realtime = realtime; this.scheduler = scheduler
  }

  onChange(handler: (state: ChatReadState) => void): () => void {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  start(): void { this.stopped = false }
  stop(): void { this.stopped = true; this.cancel?.(); this.cancel = undefined }

  private scope(): InboxScope {
    const scope = this.sync.scope()
    if (this.current !== scope) {
      this.cancel?.(); this.cancel = undefined
      this.current = scope; this.states.clear(); this.inFlight.clear()
    }
    return scope
  }

  private publish(scope: InboxScope, incoming: ChatReadState): void {
    if (this.sync.scope() !== scope) return
    const prior = this.states.get(incoming.chatId)
    const state = { ...incoming,
      ownLocalReadSeq: Math.max(prior?.ownLocalReadSeq ?? 0, incoming.ownLocalReadSeq),
      ownConfirmedReadSeq: Math.max(prior?.ownConfirmedReadSeq ?? 0, incoming.ownConfirmedReadSeq),
      peerLastReadSeq: Math.max(prior?.peerLastReadSeq ?? 0, incoming.peerLastReadSeq) }
    this.states.set(state.chatId, state)
    for (const handler of this.handlers) handler(state)
  }

  async restore(): Promise<void> {
    const scope = this.scope()
    const states = await this.sync.inbox.readChatReadStates?.(scope) ?? []
    if (this.sync.scope() !== scope) return
    for (const state of states) this.publish(scope, state)
  }

  async merge(cursor: ChatReadCursor): Promise<void> {
    const scope = this.scope()
    const state = await this.sync.inbox.mergeChatReadCursor?.(scope, cursor)
    if (state && this.sync.scope() === scope) this.publish(scope, state)
  }

  async advance(chatId: string, seq: number): Promise<void> {
    if (!Number.isSafeInteger(seq) || seq < 1) return
    const scope = this.scope()
    if (seq <= (this.states.get(chatId)?.ownLocalReadSeq ?? 0)) return
    const state = await this.sync.inbox.advanceLocalReadCursor?.(scope, chatId, seq)
    if (!state || this.sync.scope() !== scope) return
    this.publish(scope, state)
    this.schedule(150)
  }

  async synchronize(): Promise<void> {
    const scope = this.scope()
    await this.restore()
    if (this.sync.scope() !== scope) return
    if (this.api.getChatStates) {
      let after: string | undefined
      while (true) {
        const page = await this.api.getChatStates(after, 100)
        if (this.sync.scope() !== scope) return
        for (const state of page.states) for (const cursor of state.readStates) {
          if (cursor.chatId !== state.chatId) throw new Error('Invalid chat read state')
          await this.merge(cursor)
          if (this.sync.scope() !== scope) return
        }
        if (!page.hasMore) break
        if (!page.nextChatId || page.nextChatId === after) throw new Error('Chat state paging did not advance')
        after = page.nextChatId
      }
    }
    await this.flush()
  }

  private schedule(delay: number): void {
    if (this.stopped || this.cancel) return
    if (!this.scheduler) { if (delay <= 150) void this.flush().catch(() => {}); return }
    this.cancel = this.scheduler.schedule(() => { this.cancel = undefined; void this.flush().catch(() => {}) }, delay)
  }

  async flush(): Promise<void> {
    if (this.stopped || !this.realtime?.ready || !this.realtime.advanceReadCursor) return
    const scope = this.scope()
    let retry = false
    for (const state of this.states.values()) {
      if (state.ownLocalReadSeq <= state.ownConfirmedReadSeq || this.inFlight.has(state.chatId)) continue
      this.inFlight.add(state.chatId)
      try {
        const cursor = await this.realtime.advanceReadCursor(state.chatId, state.ownLocalReadSeq)
        if (this.sync.scope() !== scope) return
        if (cursor.chatId !== state.chatId || cursor.userId !== scope.userId || cursor.lastReadSeq < state.ownLocalReadSeq) throw new Error('Invalid read confirmation')
        await this.merge(cursor)
      } catch {
        if (this.sync.scope() !== scope) return
        retry = true
      } finally {
        if (this.current === scope) this.inFlight.delete(state.chatId)
      }
    }
    if (retry || [...this.states.values()].some(state => state.ownLocalReadSeq > state.ownConfirmedReadSeq)) this.schedule(1000)
  }
}
