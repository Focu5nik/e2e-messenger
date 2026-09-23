import type { ChatHistoryState, DisplayMessage } from '@secure-messenger/client-core'
import { useState, type ReactNode } from 'react'
import { useMessageVirtualization } from '../hooks/useMessageVirtualization'
import { MessageRow } from './MessageRow'

export function MessageHistory({ messages, userId, history, syncError, sending = false, loadPrevious, retryMessage, children }: {
  messages: DisplayMessage[]
  userId: string
  history?: ChatHistoryState
  syncError: string | null
  sending?: boolean
  loadPrevious(): Promise<void>
  retryMessage(id: string): Promise<void>
  children: ReactNode
}) {
  const { stage, list, total, visible, capture, stopFollowingBottom } = useMessageVirtualization(messages, userId)
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set())

  async function retry(id: string) {
    if (retrying.has(id)) return
    setRetrying(previous => new Set(previous).add(id))
    try { await retryMessage(id) }
    finally {
      setRetrying(previous => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
    }
  }

  function handleLoadPrevious() {
    stopFollowingBottom()
    void loadPrevious()
  }

  function handleRetryHistory() {
    void loadPrevious()
  }

  function handleScroll() {
    capture()
    if (stage.current!.scrollTop < 120 && history?.hasPrevious && !history.loading && !history.error) {
      handleLoadPrevious()
    }
  }

  return <div className="message-stage" ref={stage} style={{ position: 'relative', overflowAnchor: 'none' }}
    onScroll={handleScroll}>
    {syncError && <p className="message-status error" role="alert">Sync failed: {syncError}</p>}
    {history?.error && <p className="message-status error" role="alert">
      Could not load messages: {history.error} <button onClick={handleRetryHistory}>Retry</button>
    </p>}
    {history?.hasPrevious && <button disabled={history.loading} onClick={handleLoadPrevious}>Load earlier messages</button>}
    {history?.loading && <p className="message-status" aria-live="polite">Loading messages...</p>}
    {!messages.length ? (!history?.loading && !history?.error && children) :
      <ol ref={list} className="message-list" aria-label="Messages"
        style={{ position: 'relative', height: total, flex: '0 0 auto', display: 'block' }}>
        {visible.map(({ message, key, top }) => <MessageRow key={key} rowKey={key} message={message}
          top={top} own={message.senderUserId === userId} sending={sending}
          retrying={!!message.clientMessageId && retrying.has(message.clientMessageId)} retryMessage={retry} />)}
      </ol>}
  </div>
}
