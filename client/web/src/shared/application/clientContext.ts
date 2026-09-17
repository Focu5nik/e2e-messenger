import type { ChatState, ChatStore, RealtimeGateway, SessionState, SessionStore } from '@secure-messenger/client-core'
import { createContext, useContext } from 'react'
import { useStore } from 'zustand'

export type WebClient = {
  session: SessionStore
  chatStore: ChatStore
  realtime: RealtimeGateway
  checkHealth: () => Promise<boolean>
}

export const WebClientContext = createContext<WebClient | null>(null)

export function useWebClient(): WebClient {
  const client = useContext(WebClientContext)
  if (!client) throw new Error('Web client bindings require WebClientProvider')
  return client
}

export function useSessionStore<T>(selector: (state: SessionState) => T): T {
  return useStore(useWebClient().session, selector)
}

export function useChatStore<T>(selector: (state: ChatState) => T): T {
  return useStore(useWebClient().chatStore, selector)
}
