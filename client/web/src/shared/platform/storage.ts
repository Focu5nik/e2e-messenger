import type { ChatPreferencesStore } from '@secure-messenger/client-core'

const LAST_CHAT_STORAGE_KEY = 'messenger.lastChat'

export const browserChatPreferencesStore: ChatPreferencesStore = {
  async getLastChatId(userId) {
    return localStorage.getItem(`${LAST_CHAT_STORAGE_KEY}.${userId}`)
  },
  async setLastChatId(userId, chatId) {
    const key = `${LAST_CHAT_STORAGE_KEY}.${userId}`
    if (chatId === null) localStorage.removeItem(key)
    else localStorage.setItem(key, chatId)
  },
}
