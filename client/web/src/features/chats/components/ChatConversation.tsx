import type { CurrentUser } from '@secure-messenger/client-core'
import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../../../shared/application/clientContext'
import { MessageComposer } from './MessageComposer'

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

function formatMessageTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date)
}

export function ChatConversation({ user }: { user: CurrentUser }) {
  const { selectedChat, messages, loadingMailbox, mailboxError } = useChatStore((state) => state)
  const [draft, setDraft] = useState('')
  const messageStage = useRef<HTMLDivElement>(null)
  const selectedChatId = selectedChat?.id
  const selectedMessages = selectedChat
    ? messages.filter((message) => message.chatId === selectedChat.id)
    : []

  useEffect(() => {
    const stage = messageStage.current
    if (stage) stage.scrollTop = stage.scrollHeight
  }, [selectedChatId, selectedMessages.length])

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
          <div className="message-stage" ref={messageStage}>
            {mailboxError && (
              <p className="message-status error" role="alert">
                Could not load messages: {mailboxError}
              </p>
            )}
            {loadingMailbox ? (
              <p className="message-status" aria-live="polite">Loading messages...</p>
            ) : selectedMessages.length === 0 ? (
              <div className="chat-empty-state message-empty">
                <div className="empty-lock" aria-hidden="true">S</div>
                <h3>No messages yet</h3>
                <p>Send the first message to {selectedChat.otherUser.username}.</p>
                <small>Chat created {formatDate(selectedChat.createdAt)}</small>
              </div>
            ) : (
              <ol className="message-list" aria-label="Messages">
                {selectedMessages.map((message) => {
                  const isOwn = message.senderUserId === user.id
                  return (
                    <li
                      key={message.messageId}
                      className={isOwn ? 'message own' : 'message received'}
                    >
                      <div>
                        <p>{message.content}</p>
                        <time dateTime={message.createdAt}>
                          {formatMessageTime(message.createdAt)}
                        </time>
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
          </div>
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
