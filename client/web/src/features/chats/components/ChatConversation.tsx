import type { CurrentUser, DisplayMessage } from '@secure-messenger/client-core'
import { useState } from 'react'
import { MessageHistory } from './MessageHistory'
import { useChatStore } from '../../../shared/application/clientContext'
import { MessageComposer } from './MessageComposer'

const EMPTY_MESSAGES: DisplayMessage[] = []

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

export function ChatConversation({ user }: { user: CurrentUser }) {
  const selectedChat = useChatStore((state) => state.selectedChat)
  const selectedMessages = useChatStore((state) => state.selectedChat
    ? state.messagesByChat.get(state.selectedChat.id) ?? EMPTY_MESSAGES : EMPTY_MESSAGES)
  const history = useChatStore(state => state.selectedChat ? state.historyByChat.get(state.selectedChat.id) : undefined)
  const loadPrevious = useChatStore(state => state.loadPreviousMessages)
  const mailboxError = useChatStore((state) => state.mailboxError)
  const sending = useChatStore((state) => state.sending || state.loadingMailbox)
  const retryMessage = useChatStore((state) => state.retryMessage)
  const [draft, setDraft] = useState('')
  return (
    <section className="chat-stage" aria-labelledby="selected-chat-heading">
      {selectedChat ? (
        <>
          <header className="chat-stage-header">
            <div className="person-avatar large" aria-hidden="true">
              {selectedChat.otherUser.username.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <p className="eyebrow">Direct chat</p>
              <h2 id="selected-chat-heading">{selectedChat.otherUser.username}</h2>
            </div>
            <span className="secure-pill">Private</span>
          </header>
          <MessageHistory key={selectedChat.id} messages={selectedMessages} userId={user.id} sending={sending}
            history={history} syncError={mailboxError} loadPrevious={loadPrevious} retryMessage={retryMessage}>
            <div className="chat-empty-state message-empty">
              <div className="empty-lock" aria-hidden="true">S</div>
              <h3>No messages yet</h3>
              <p>Send the first message to {selectedChat.otherUser.username}.</p>
              <small>Chat created {formatDate(selectedChat.createdAt)}</small>
            </div>
          </MessageHistory>
          <MessageComposer chat={selectedChat} draft={draft} setDraft={setDraft} />
        </>
      ) : (
        <div className="chat-empty-state no-selection">
          <div className="empty-bubbles" aria-hidden="true">...</div>
          <h2 id="selected-chat-heading">Choose a conversation</h2>
          <p>Select a direct chat or find someone new by username.</p>
        </div>
      )}
    </section>
  )
}
