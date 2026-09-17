import type { ChatPreferencesStore, DeviceIdentityStore } from '@secure-messenger/client-core'

const DEVICE_STORAGE_KEY = 'messenger.device'
const LAST_CHAT_STORAGE_KEY = 'messenger.lastChat'

export const browserDeviceIdentityStore: DeviceIdentityStore = {
  async read() {
    const value = localStorage.getItem(DEVICE_STORAGE_KEY)
    if (!value) return null
    try { return JSON.parse(value) as unknown } catch { return null }
  },
  async write(identity) {
    localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(identity))
  },
}

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
