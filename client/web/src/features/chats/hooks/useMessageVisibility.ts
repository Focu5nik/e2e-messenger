import { useEffect, useRef, type RefObject } from 'react'

// Virtualization includes overscan rows. Only content intersecting the actual
// viewport in a focused, visible document is evidence that a message was read.
export function useMessageVisibility(
  stage: RefObject<HTMLDivElement | null>,
  reportVisible?: (lastReadSeq: number) => void,
) {
  const reported = useRef(0)

  useEffect(() => {
    const root = stage.current
    if (!root || !reportVisible) return
    let active = true
    const report = () => {
      if (!active || root.closest('[hidden]') || document.visibilityState !== 'visible' || !document.hasFocus()) return
      const viewport = root.getBoundingClientRect()
      const top = Math.max(0, viewport.top)
      const bottom = Math.min(window.innerHeight, viewport.bottom)
      const left = Math.max(0, viewport.left)
      const right = Math.min(window.innerWidth, viewport.right)
      let lastReadSeq = reported.current
      for (const content of root.querySelectorAll<HTMLElement>('[data-read-seq]')) {
        const rect = content.getBoundingClientRect()
        const seq = Number(content.dataset.readSeq)
        if (Number.isSafeInteger(seq) && seq > lastReadSeq && rect.height > 0 && rect.width > 0
          && rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right
          && bottom > top && right > left) lastReadSeq = seq
      }
      if (lastReadSeq > reported.current) {
        reported.current = lastReadSeq
        reportVisible(lastReadSeq)
      }
    }
    const contents = root.querySelectorAll('[data-read-seq]')
    const intersection = typeof IntersectionObserver === 'undefined' ? null
      : new IntersectionObserver(report, { root })
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report)
    resize?.observe(root)
    for (const content of contents) {
      intersection?.observe(content)
      resize?.observe(content)
    }
    root.addEventListener('scroll', report)
    window.addEventListener('focus', report)
    window.addEventListener('resize', report)
    document.addEventListener('visibilitychange', report)
    report()
    return () => {
      active = false
      intersection?.disconnect()
      resize?.disconnect()
      root.removeEventListener('scroll', report)
      window.removeEventListener('focus', report)
      window.removeEventListener('resize', report)
      document.removeEventListener('visibilitychange', report)
    }
  })
}
