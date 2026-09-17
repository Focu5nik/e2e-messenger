import type { DirectChat } from '@secure-messenger/client-core'
import { useEffect, useRef, type FormEvent } from 'react'
import { useChatStore } from '../../../shared/application/clientContext'

type MessageComposerProps = {
  chat: DirectChat
  draft: string
  setDraft: (draft: string) => void
}

export function MessageComposer({ chat, draft, setDraft }: MessageComposerProps) {
  const { sending, sendError, sendText } = useChatStore((state) => state)
  const messageDraft = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!sending) messageDraft.current?.focus()
  }, [chat.id, sending])

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (await sendText(draft)) setDraft('')
  }

  return (
    <form className="message-composer" onSubmit={handleSend}>
      <label className="sr-only" htmlFor="message-draft">Message</label>
      <textarea
        ref={messageDraft}
        id="message-draft"
        name="message"
        rows={2}
        placeholder={`Message ${chat.otherUser.username}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          event.currentTarget.form?.requestSubmit()
        }}
        disabled={sending}
      />
      <button type="submit" disabled={sending || !draft.trim()}>
        {sending ? 'Sending...' : 'Send'}
      </button>
      {sendError && <p className="compact-error" role="alert">{sendError}</p>}
    </form>
  )
}
