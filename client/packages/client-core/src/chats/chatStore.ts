import { createStore } from 'zustand/vanilla'
import type { DirectChat, DisplayMessage, ReceivedMessage, User } from '../domain/models.ts'
import type { ChatGateway } from '../ports/gateways.ts'
import type { MessengerService } from '../messaging/messengerService.ts'
import { mergeMessages } from '../messaging/messageState.ts'
import type { ChatPreferencesService } from './chatPreferences.ts'

export type ChatStoreDependencies = {
  chats: ChatGateway
  messenger: Pick<MessengerService, 'loadMailbox' | 'subscribe' | 'onReady' | 'sendText'>
  preferences: Pick<ChatPreferencesService, 'restore' | 'select'>
}

export type ChatState = {
  userId: string | null
  chats: DirectChat[]
  selectedChat: DirectChat | null
  loadingChats: boolean
  loadingChatId: string | null
  chatsError: string | null
  search: string
  searchResults: User[] | null
  searching: boolean
  searchError: string | null
  openingUserId: string | null
  messages: DisplayMessage[]
  loadingMailbox: boolean
  mailboxError: string | null
  sending: boolean
  sendError: string | null
  // Each start replaces the previous lifecycle, including for the same user.
  start(userId: string): Promise<void>
  dispose(): void
  selectChat(chat: DirectChat): Promise<void>
  setSearch(value: string): void
  findPeople(): Promise<void>
  openDirectChat(userId: string): Promise<void>
  reloadMailbox(): Promise<void>
  // True means the message was accepted during the current lifecycle.
  sendText(content: string): Promise<boolean>
}

type ChatRun = {
  userId: string
  selection: number
  searchRequest: number
  loadingMailbox: boolean
  reloadRequested: boolean
  discoveredChats: Set<string>
  unsubscribe: () => void
  unsubscribeReady: () => void
}

function initialState() {
  return {
    userId: null, chats: [], selectedChat: null, loadingChats: true, loadingChatId: null,
    chatsError: null, search: '', searchResults: null, searching: false, searchError: null,
    openingUserId: null, messages: [], loadingMailbox: true, mailboxError: null,
    sending: false, sendError: null,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

function upsertChat(chats: DirectChat[], chat: DirectChat): DirectChat[] {
  const existingIndex = chats.findIndex((candidate) => candidate.id === chat.id)
  if (existingIndex === -1) return [chat, ...chats]
  const nextChats = [...chats]
  nextChats[existingIndex] = chat
  return nextChats
}

export function createChatStore({ chats: gateway, messenger, preferences }: ChatStoreDependencies) {
  let run: ChatRun | null = null

  return createStore<ChatState>()((set, get) => {
    function receive(current: ChatRun, messages: ReceivedMessage[]) {
      if (run !== current) return
      set((state) => ({ messages: mergeMessages(state.messages, messages) }))
      for (const message of messages) {
        if (current.discoveredChats.has(message.chatId)) continue
        current.discoveredChats.add(message.chatId)
        void gateway.getChat(message.chatId).then((chat) => {
          if (run === current) set((state) => ({ chats: upsertChat(state.chats, chat) }))
        }).catch((error: unknown) => {
          current.discoveredChats.delete(message.chatId)
          if (run === current) set({ chatsError: errorMessage(error) })
        })
      }
    }

    async function loadMailbox(current: ChatRun) {
      if (run !== current) return
      if (current.loadingMailbox) { current.reloadRequested = true; return }
      current.loadingMailbox = true
      try {
        const result = await messenger.loadMailbox()
        receive(current, result.messages)
        if (run === current) set({ mailboxError: null })
      } catch (error) {
        if (run === current) set({ mailboxError: errorMessage(error) })
      } finally {
        current.loadingMailbox = false
        if (run === current) {
          set({ loadingMailbox: false })
          if (current.reloadRequested) {
            current.reloadRequested = false
            void loadMailbox(current)
          }
        }
      }
    }

    async function loadChats(current: ChatRun) {
      const request = current.selection
      try {
        const chats = await gateway.getChats()
        if (run !== current) return
        set((state) => ({ chats: state.chats.reduce(upsertChat, chats), loadingChats: false }))
        if (request !== current.selection) return
        const lastChat = await preferences.restore(current.userId, chats)
        if (run !== current || request !== current.selection) return
        if (lastChat) await get().selectChat(lastChat)
      } catch (error) {
        if (run === current && request === current.selection) set({ chatsError: errorMessage(error) })
      } finally {
        if (run === current) set({ loadingChats: false })
      }
    }

    return {
      ...initialState(),

      async start(userId) {
        get().dispose()
        const current: ChatRun = {
          userId, selection: 0, searchRequest: 0, loadingMailbox: false, reloadRequested: false,
          discoveredChats: new Set(), unsubscribe: () => {}, unsubscribeReady: () => {},
        }
        run = current
        set({ userId })
        current.unsubscribe = messenger.subscribe(
          (message) => receive(current, [message]),
          (error) => { if (run === current) set({ mailboxError: errorMessage(error) }) },
        )
        // Cover messages arriving during connection setup and reconnects.
        current.unsubscribeReady = messenger.onReady(() => { void loadMailbox(current) })
        await Promise.all([loadChats(current), loadMailbox(current)])
      },

      dispose() {
        const previous = run
        run = null
        previous?.unsubscribe()
        previous?.unsubscribeReady()
        set(initialState())
      },

      async selectChat(chat) {
        const current = run
        if (!current) return
        const request = ++current.selection
        const isCurrent = () => run === current && request === current.selection
        set({ selectedChat: chat, loadingChatId: chat.id, chatsError: null, sendError: null })
        try {
          await preferences.select(current.userId, chat.id)
          if (!isCurrent()) return
          const freshChat = await gateway.getChat(chat.id)
          if (!isCurrent()) return
          set((state) => ({ selectedChat: freshChat, chats: upsertChat(state.chats, freshChat) }))
        } catch (error) {
          if (!isCurrent()) return
          set({ selectedChat: null, chatsError: errorMessage(error) })
          try {
            await preferences.select(current.userId, null)
          } catch (storageError) {
            if (isCurrent()) set({ chatsError: errorMessage(storageError) })
          }
        } finally {
          if (isCurrent()) set({ loadingChatId: null })
        }
      },

      setSearch(search) { set({ search }) },

      async findPeople() {
        const current = run
        if (!current) return
        const request = ++current.searchRequest
        const isCurrent = () => run === current && request === current.searchRequest
        set({ searching: true, searchError: null })
        try {
          const searchResults = await gateway.searchUsers(get().search.trim())
          if (isCurrent()) set({ searchResults })
        } catch (error) {
          if (isCurrent()) set({ searchResults: null, searchError: errorMessage(error) })
        } finally {
          if (isCurrent()) set({ searching: false })
        }
      },

      async openDirectChat(userId) {
        const current = run
        if (!current || get().openingUserId) return
        const request = ++current.selection
        const isCurrent = () => run === current && request === current.selection
        set({ openingUserId: userId, loadingChatId: null, searchError: null })
        try {
          const chat = await gateway.createDirectChat(userId)
          if (run !== current) return
          set((state) => ({ chats: upsertChat(state.chats, chat) }))
          if (!isCurrent()) return
          current.searchRequest += 1
          set({ selectedChat: chat, chatsError: null, sendError: null, search: '', searchResults: null, searching: false })
          await preferences.select(current.userId, chat.id)
        } catch (error) {
          if (isCurrent()) set({ searchError: errorMessage(error) })
        } finally {
          if (run === current) set({ openingUserId: null })
        }
      },

      async reloadMailbox() { if (run) await loadMailbox(run) },

      async sendText(content) {
        const current = run
        const chat = get().selectedChat
        if (!current || !chat || !content.trim() || get().sending) return false
        const request = current.selection
        set({ sending: true, sendError: null })
        try {
          const accepted = await messenger.sendText(chat.id, content)
          if (run !== current) return false
          set((state) => ({ messages: mergeMessages(state.messages, [{
            messageId: accepted.id, chatId: accepted.chatId, senderUserId: accepted.senderUserId,
            content, createdAt: accepted.createdAt,
          }]) }))
          return true
        } catch (error) {
          if (run === current && request === current.selection) set({ sendError: errorMessage(error) })
          return false
        } finally {
          if (run === current) set({ sending: false })
        }
      },
    }
  })
}

export type ChatStore = ReturnType<typeof createChatStore>
