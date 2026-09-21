import type { ChatHistoryState, DisplayMessage } from '@secure-messenger/client-core'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const GAP = 10
const ESTIMATED_HEIGHT = 90
const OVERSCAN = 400
const keyOf = (message: DisplayMessage) => message.status && message.clientMessageId && message.senderDeviceId
  ? `${message.senderDeviceId}:${message.clientMessageId}` : message.messageId

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
  const stage = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const heights = useRef(new Map<string, number>())
  const anchor = useRef<{ key: string; offset: number } | null>(null)
  const atBottom = useRef(true)
  const previousMessages = useRef<DisplayMessage[]>([])
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const [, measureAgain] = useState(0)
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

  let total = 0
  const rows = messages.map(message => {
    const key = keyOf(message)
    const top = total
    const height = heights.current.get(key) ?? ESTIMATED_HEIGHT
    total += height + GAP
    return { message, key, top, height }
  })
  const visible = rows.filter(row => row.top + row.height >= viewport.top - OVERSCAN
    && row.top <= viewport.top + viewport.height + OVERSCAN)

  function capture() {
    const element = stage.current
    if (!element) return
    const top = element.scrollTop - (list.current?.offsetTop ?? 0)
    const row = rows.find(row => row.top + row.height > top)
    anchor.current = row ? { key: row.key, offset: row.top - top } : null
    // Only allow rounding tolerance: a near-bottom threshold traps small upward scrolls.
    atBottom.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 1
    setViewport(previous => previous.top === top && previous.height === element.clientHeight
      ? previous : { top, height: element.clientHeight })
  }

  useLayoutEffect(() => {
    const element = stage.current
    if (!element) return
    if (messages !== previousMessages.current) {
      const latest = messages.at(-1)
      // Follow a new outgoing message, but not history prepends or status updates.
      if (latest?.senderUserId === userId
        && !previousMessages.current.some(message => keyOf(message) === keyOf(latest))) {
        atBottom.current = true
      }
      previousMessages.current = messages
    }
    if (atBottom.current) element.scrollTop = element.scrollHeight
    else if (anchor.current) {
      const row = rows.find(row => row.key === anchor.current!.key)
      if (row) element.scrollTop = (list.current?.offsetTop ?? 0) + row.top - anchor.current.offset
    }
    capture()
    const measure = () => {
      let changed = false
      for (const child of list.current?.children ?? []) {
        const row = child as HTMLElement
        const height = row.getBoundingClientRect().height
        if (height > 0 && heights.current.get(row.dataset.key!) !== height) {
          heights.current.set(row.dataset.key!, height)
          changed = true
        }
      }
      if (changed) measureAgain(value => value + 1)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const child of list.current?.children ?? []) observer.observe(child)
    return () => observer.disconnect()
  })

  return <div className="message-stage" ref={stage} style={{ position: 'relative', overflowAnchor: 'none' }}
    onScroll={() => {
      capture()
      if (stage.current!.scrollTop < 120 && history?.hasPrevious && !history.loading && !history.error) {
        atBottom.current = false
        void loadPrevious()
      }
    }}>
    {syncError && <p className="message-status error" role="alert">Sync failed: {syncError}</p>}
    {history?.error && <p className="message-status error" role="alert">
      Could not load messages: {history.error} <button onClick={() => { void loadPrevious() }}>Retry</button>
    </p>}
    {history?.hasPrevious && <button disabled={history.loading} onClick={() => {
      atBottom.current = false
      void loadPrevious()
    }}>Load earlier messages</button>}
    {history?.loading && <p className="message-status" aria-live="polite">Loading messages...</p>}
    {!messages.length ? (!history?.loading && !history?.error && children) :
      <ol ref={list} className="message-list" aria-label="Messages"
        style={{ position: 'relative', height: total, flex: '0 0 auto', display: 'block' }}>
        {visible.map(({ message, key, top }) => {
          const own = message.senderUserId === userId
          return <li key={key} data-key={key} className={own ? 'message own' : 'message received'}
            style={{ position: 'absolute', top, right: own ? 0 : undefined, left: own ? undefined : 0 }}>
            <div>
              <p>{message.content}</p>
              <div className="message-meta">
                <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time>
                {own && message.status && <small aria-label="Message status">{message.status}</small>}
                {own && message.status === 'pending' && message.clientMessageId && !sending &&
                  <button type="button" className="message-retry" aria-label="Retry sending message"
                    disabled={retrying.has(message.clientMessageId)} aria-busy={retrying.has(message.clientMessageId)}
                    onClick={() => { void retry(message.clientMessageId!) }}>Retry</button>}
              </div>
            </div>
          </li>
        })}
      </ol>}
  </div>
}
