import type { DisplayMessage } from '@secure-messenger/client-core'
import { useLayoutEffect, useRef, useState } from 'react'

const GAP = 10
const ESTIMATED_HEIGHT = 90
const OVERSCAN = 400
const keyOf = (message: DisplayMessage) => message.status && message.clientMessageId && message.senderDeviceId
  ? `${message.senderDeviceId}:${message.clientMessageId}` : message.messageId

export function useMessageVirtualization(messages: DisplayMessage[], userId: string) {
  const stage = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const heights = useRef(new Map<string, number>())
  const anchor = useRef<{ key: string; offset: number } | null>(null)
  const atBottom = useRef(true)
  const previousMessages = useRef<DisplayMessage[]>([])
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const [, measureAgain] = useState(0)

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

  function stopFollowingBottom() {
    atBottom.current = false
  }

  // Keep restoration, capture, measurement and observer setup in this order on every commit.
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

  return { stage, list, total, visible, capture, stopFollowingBottom }
}
