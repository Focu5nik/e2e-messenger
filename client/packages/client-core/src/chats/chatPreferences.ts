import type { DirectChat } from '../domain/models.ts'
import type { ChatPreferencesStore } from '../ports/platform.ts'

export class ChatPreferencesService {
  private readonly store: ChatPreferencesStore
  private pending: Promise<unknown> = Promise.resolve()

  constructor(store: ChatPreferencesStore) {
    this.store = store
  }

  restore(userId: string, chats: DirectChat[]): Promise<DirectChat | null> {
    return this.enqueue(async () => {
      const chatId = await this.store.getLastChatId(userId)
      const chat = chats.find((candidate) => candidate.id === chatId) ?? null
      if (!chat && chatId) await this.store.setLastChatId(userId, null)
      return chat
    })
  }

  select(userId: string, chatId: string | null): Promise<void> {
    return this.enqueue(() => this.store.setLastChatId(userId, chatId))
  }

  // Keep asynchronous writes and missing-chat cleanup in selection order.
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => {})
    return result
  }
}
