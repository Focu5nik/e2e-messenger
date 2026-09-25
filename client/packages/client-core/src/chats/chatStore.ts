import { createStore } from 'zustand/vanilla'
import type { ChatReadState, DirectChat, DisplayMessage, User } from '../domain/models.ts'
import type { ChatHistoryCursor } from '../ports/durableInbox.ts'
import type { ChatGateway } from '../ports/gateways.ts'
import type { MessengerService } from '../messaging/messengerService.ts'
import { mergeMessagesByChat, type MessagesByChat } from '../messaging/messageState.ts'
import type { ChatPreferencesService } from './chatPreferences.ts'

export type ChatStoreDependencies = {
  chats: ChatGateway
  messenger: Pick<MessengerService, 'loadMailbox' | 'subscribe' | 'onReady' | 'sendText'>
    & Partial<Pick<MessengerService, 'onReadState' | 'advanceReadCursor' | 'onChatActivity' | 'restoreMetadata' | 'loadChatHistory' | 'setHistoryChats' | 'cacheChats' | 'onOutgoing' | 'onDelivery' | 'retryOutgoing'>>
  preferences: Pick<ChatPreferencesService, 'restore' | 'select'>
}

export type ChatHistoryState = {
  loading: boolean
  error: string | null
  loaded: boolean
  hasPrevious: boolean
  cursor: ChatHistoryCursor | null
}
const emptyHistory = (): ChatHistoryState => ({ loading: false, error: null, loaded: false, hasPrevious: false, cursor: null })
const MAX_CACHED_CHATS = 3

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
  messagesByChat: MessagesByChat
  readStatesByChat: ReadonlyMap<string, ChatReadState>
  reportVisibleMessages(chatId: string, lastReadSeq: number): void
  historyByChat: ReadonlyMap<string, ChatHistoryState>
  loadPreviousMessages(): Promise<void>
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
  // True means the message was accepted during the current lifecycle.
  sendText(content: string): Promise<boolean>
  retryMessage(clientMessageId: string): Promise<void>
}

type ChatRun = {
  userId: string
  selection: number
  searchRequest: number
  loadingMailbox: boolean
  reloadRequested: boolean
  historyRequests: Map<string, object>
  recentChats: string[]
  discoveredChats: Set<string>
  unsubscribe: () => void
  unsubscribeReady: () => void
  unsubscribeOutgoing: () => void
  unsubscribeDelivery: () => void
  unsubscribeActivity: () => void
  unsubscribeRead: () => void
}

function createChatRun(userId: string): ChatRun {
  return {
    userId,
    selection: 0,
    searchRequest: 0,
    loadingMailbox: false,
    reloadRequested: false,
    historyRequests: new Map(),
    recentChats: [],
    discoveredChats: new Set(),
    unsubscribe: () => {},
    unsubscribeReady: () => {},
    unsubscribeOutgoing: () => {},
    unsubscribeDelivery: () => {},
    unsubscribeActivity: () => {},
    unsubscribeRead: () => {},
  }
}

function initialState() {
  return {
    userId: null, chats: [], selectedChat: null, loadingChats: true, loadingChatId: null,
    chatsError: null, search: '', searchResults: null, searching: false, searchError: null,
    openingUserId: null, messagesByChat: new Map<string, DisplayMessage[]>(), loadingMailbox: true, mailboxError: null,
    readStatesByChat: new Map<string, ChatReadState>(),
    historyByChat: new Map<string, ChatHistoryState>(),
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
    function receive(current: ChatRun, messages: DisplayMessage[], chatIds = messages.map(message => message.chatId)) {
      if (run !== current) return
      set((state) => {
        const messagesByChat = mergeMessagesByChat(state.messagesByChat, messenger.loadChatHistory ? messages.filter(message => state.historyByChat.has(message.chatId)) : messages)
        return messagesByChat === state.messagesByChat ? state : { messagesByChat }
      })
      for (const chatId of chatIds) {
        if (current.discoveredChats.has(chatId)) continue
        current.discoveredChats.add(chatId)
        void gateway.getChat(chatId).then((chat) => {
          if (run === current) {
            set((state) => ({ chats: upsertChat(state.chats, chat) }))
            void messenger.cacheChats?.([chat]).catch((error: unknown) => {
              if (run === current) set({ chatsError: errorMessage(error) })
            })
          }
        }).catch((error: unknown) => {
          current.discoveredChats.delete(chatId)
          if (run === current) set({ chatsError: errorMessage(error) })
        })
      }
    }

    function retainHistory(current: ChatRun, chatId: string) {
      if (!messenger.loadChatHistory) return
      current.recentChats = [chatId, ...current.recentChats.filter(id => id !== chatId)].slice(0, MAX_CACHED_CHATS)
      const retained = new Set(current.recentChats)
      for (const id of current.historyRequests.keys()) if (!retained.has(id)) current.historyRequests.delete(id)
      set(state => ({
        messagesByChat: new Map([...state.messagesByChat].filter(([id]) => retained.has(id))),
        historyByChat: new Map([...state.historyByChat].filter(([id]) => retained.has(id))),
      }))
      messenger.setHistoryChats?.(current.recentChats)
    }

    async function loadHistory(current: ChatRun, chatId: string, previous = false) {
      if (run !== current || !messenger.loadChatHistory) return
      const history = get().historyByChat.get(chatId) ?? emptyHistory()
      if (history.loading || (previous ? !history.hasPrevious : history.loaded)) return
      const request = {}
      current.historyRequests.set(chatId, request)
      const isCurrent = () => run === current && current.historyRequests.get(chatId) === request
      set(state => ({ historyByChat: new Map(state.historyByChat).set(chatId, { ...history, loading: true, error: null }) }))
      try {
        const page = await messenger.loadChatHistory(chatId, previous ? history.cursor ?? undefined : undefined)
        if (!isCurrent()) return
        set(state => ({
          messagesByChat: mergeMessagesByChat(state.messagesByChat, page.messages),
          historyByChat: new Map(state.historyByChat).set(chatId, {
            loading: false, error: null, loaded: true, hasPrevious: page.nextBefore !== null, cursor: page.nextBefore,
          }),
        }))
      } catch (error) {
        if (isCurrent()) set(state => ({ historyByChat: new Map(state.historyByChat).set(chatId, { ...history, loading: false, error: errorMessage(error) }) }))
      } finally {
        if (isCurrent()) current.historyRequests.delete(chatId)
      }
    }

    async function loadMailbox(current: ChatRun) {
      if (run !== current) return
      if (current.loadingMailbox) { current.reloadRequested = true; return }
      current.loadingMailbox = true
      set({ loadingMailbox: true })
      try {
        const result = await messenger.loadMailbox()
        receive(current, result.messages, [...new Set([...result.messages.map(message => message.chatId), ...result.envelopes.map(envelope => envelope.chat_id)])])
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
        await messenger.cacheChats?.(chats)
        if (run !== current) return
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

    function subscribeToMessenger(current: ChatRun) {
      current.unsubscribeRead = messenger.onReadState?.(incoming => {
        if (run !== current) return
        set(state => {
          const prior = state.readStatesByChat.get(incoming.chatId)
          return { readStatesByChat: new Map(state.readStatesByChat).set(incoming.chatId, { ...incoming,
            ownLocalReadSeq: Math.max(prior?.ownLocalReadSeq ?? 0, incoming.ownLocalReadSeq),
            ownConfirmedReadSeq: Math.max(prior?.ownConfirmedReadSeq ?? 0, incoming.ownConfirmedReadSeq),
            peerLastReadSeq: Math.max(prior?.peerLastReadSeq ?? 0, incoming.peerLastReadSeq) }) }
        })
      }) ?? (() => {})
      current.unsubscribe = messenger.subscribe(
        (messages) => receive(current, messages),
        (error) => {
          if (run === current) set({ mailboxError: errorMessage(error) })
        },
      )
      current.unsubscribeActivity = messenger.onChatActivity?.(ids => receive(current, [], ids)) ?? (() => {})
      current.unsubscribeOutgoing = messenger.onOutgoing?.(messages => receive(current, messages)) ?? (() => {})
      current.unsubscribeDelivery = messenger.onDelivery?.(update => {
        if (run !== current) return
        const message = get().messagesByChat.get(update.chatId)?.find(item => item.messageId === update.messageId)
        if (message) receive(current, [{ ...message, ...update }])
      }) ?? (() => {})

      // Cover messages arriving during connection setup and reconnects.
      current.unsubscribeReady = messenger.onReady(() => { void loadMailbox(current) })
    }

    async function restoreLocalState(current: ChatRun) {
      if (!messenger.restoreMetadata) return
      try {
        const local = await messenger.restoreMetadata()
        if (run !== current) return
        set((state) => ({
          chats: state.chats.reduce(upsertChat, local.chats),
          messagesByChat: mergeMessagesByChat(state.messagesByChat, local.messages),
        }))
        for (const chat of local.chats) current.discoveredChats.add(chat.id)

        const selectedChat = local.chats.length ? await preferences.restore(current.userId, local.chats) : null
        if (run !== current || current.selection !== 0) return
        set({ selectedChat })
        if (selectedChat) {
          retainHistory(current, selectedChat.id)
          await loadHistory(current, selectedChat.id)
        }
      } catch (error) {
        if (run === current) set({ mailboxError: errorMessage(error) })
      }
    }

    return {
      ...initialState(),

      async start(userId) {
        get().dispose()
        const current = createChatRun(userId)
        run = current
        set({ userId })
        messenger.setHistoryChats?.([])

        subscribeToMessenger(current)
        if (messenger.restoreMetadata) await restoreLocalState(current)
        if (run !== current) return
        await Promise.all([loadChats(current), loadMailbox(current)])
      },

      dispose() {
        const previous = run
        run = null
        previous?.unsubscribe()
        previous?.unsubscribeReady()
        previous?.unsubscribeOutgoing()
        previous?.unsubscribeDelivery()
        previous?.unsubscribeActivity()
        previous?.unsubscribeRead()
        messenger.setHistoryChats?.([])
        set(initialState())
      },

      async selectChat(chat) {
        const current = run
        if (!current) return
        const request = ++current.selection
        const isCurrent = () => run === current && request === current.selection
        set({ selectedChat: chat, loadingChatId: chat.id, chatsError: null, sendError: null })
        retainHistory(current, chat.id)
        const historyLoad = loadHistory(current, chat.id)
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
          await historyLoad
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
          retainHistory(current, chat.id)
          await loadHistory(current, chat.id)
          if (!isCurrent()) return
          await preferences.select(current.userId, chat.id)
        } catch (error) {
          if (isCurrent()) set({ searchError: errorMessage(error) })
        } finally {
          if (run === current) set({ openingUserId: null })
        }
      },

      reportVisibleMessages(chatId, lastReadSeq) {
        const current = run
        if (!current || get().selectedChat?.id !== chatId || !Number.isSafeInteger(lastReadSeq) || lastReadSeq < 1) return
        // Only decoded incoming content actually retained by the active view is eligible.
        if (!get().messagesByChat.get(chatId)?.some(message => message.chatSeq === lastReadSeq && message.senderUserId !== current.userId)) return
        void messenger.advanceReadCursor?.(chatId, lastReadSeq).catch(error => {
          if (run === current) set({ mailboxError: errorMessage(error) })
        })
      },

      async loadPreviousMessages() {
        const chatId = get().selectedChat?.id
        if (run && chatId) await loadHistory(run, chatId, get().historyByChat.get(chatId)?.loaded ?? false)
      },

      async retryMessage(clientMessageId) {
        const current = run
        if (!current) return
        set({ sendError: null })
        try { await messenger.retryOutgoing?.(clientMessageId) }
        catch (error) { if (run === current) set({ sendError: errorMessage(error) }) }
      },

      async sendText(content) {
        const current = run
        const chat = get().selectedChat
        if (!current || !chat || !content.trim() || get().sending) return false
        const request = current.selection
        set({ sending: true, sendError: null })
        try {
          const accepted = await messenger.sendText(chat.id, content)
          if (run !== current) return false
          receive(current, [{
            messageId: accepted.id, chatId: accepted.chatId, chatSeq: accepted.chatSeq, senderUserId: accepted.senderUserId,
            content, createdAt: accepted.createdAt, clientMessageId: accepted.clientMessageId, senderDeviceId: accepted.senderDeviceId, status: 'accepted',
          }])
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
