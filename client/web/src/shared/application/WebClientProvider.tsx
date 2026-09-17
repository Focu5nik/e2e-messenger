import { useEffect, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { WebClientContext, type WebClient } from './clientContext'

type WebClientProviderProps = {
  client: WebClient
  children: ReactNode
}

export function WebClientProvider({ client, children }: WebClientProviderProps) {
  const { session, chatStore, realtime } = client
  const phase = useStore(session, (state) => state.phase)
  const user = useStore(session, (state) => state.user)

  useEffect(() => {
    void session.getState().restore()
    return () => session.getState().dispose()
  }, [session])

  useEffect(() => {
    if (phase !== 'authenticated' || !user) return
    void chatStore.getState().start(user.id)
    return () => chatStore.getState().dispose()
  }, [phase, user, chatStore])

  useEffect(() => {
    if (phase !== 'authenticated' || !user) return
    realtime.start()
    return () => realtime.stop()
  }, [phase, user, realtime])

  return <WebClientContext.Provider value={client}>{children}</WebClientContext.Provider>
}
