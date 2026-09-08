import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  getErrorMessage,
  type ApiClient,
  type CurrentUser,
  type DirectChat,
  type User,
} from '../../../shared/api'
import {
  MessengerService,
  PlaintextMessageCodec,
  type ReceivedMessage,
} from '../../messaging'

type ChatWorkspaceProps = {
  api: ApiClient
  user: CurrentUser
}

const LAST_CHAT_STORAGE_KEY = 'messenger.lastChat'

function lastChatStorageKey(userId: string): string {
  return `${LAST_CHAT_STORAGE_KEY}.${userId}`
}

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

type DisplayMessage = Pick<
  ReceivedMessage,
  'messageId' | 'chatId' | 'senderUserId' | 'content' | 'createdAt'
>

function upsertChat(chats: DirectChat[], chat: DirectChat): DirectChat[] {
  const existingIndex = chats.findIndex((candidate) => candidate.id === chat.id)
  if (existingIndex === -1) return [chat, ...chats]

  const nextChats = [...chats]
  nextChats[existingIndex] = chat
  return nextChats
}

export function ChatWorkspace({ api, user }: ChatWorkspaceProps) {
  const messenger = useMemo(
    () => new MessengerService(api, new PlaintextMessageCodec()),
    [api],
  )
  const [chats, setChats] = useState<DirectChat[]>([])
  const [selectedChat, setSelectedChat] = useState<DirectChat | null>(null)
  const [loadingChats, setLoadingChats] = useState(true)
  const [loadingChatId, setLoadingChatId] = useState<string | null>(null)
  const [chatsError, setChatsError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<User[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [openingUserId, setOpeningUserId] = useState<string | null>(null)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [loadingMailbox, setLoadingMailbox] = useState(true)
  const [mailboxError, setMailboxError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const selectionRequest = useRef(0)

  const selectChat = useCallback(async (chat: DirectChat) => {
    const request = selectionRequest.current + 1
    selectionRequest.current = request
    setSelectedChat(chat)
    setLoadingChatId(chat.id)
    setChatsError(null)
    setSendError(null)
    localStorage.setItem(lastChatStorageKey(user.id), chat.id)

    try {
      const freshChat = await api.getChat(chat.id)
      if (request !== selectionRequest.current) return
      setSelectedChat(freshChat)
      setChats((current) => upsertChat(current, freshChat))
    } catch (error) {
      if (request !== selectionRequest.current) return
      setSelectedChat(null)
      localStorage.removeItem(lastChatStorageKey(user.id))
      setChatsError(getErrorMessage(error))
    } finally {
      if (request === selectionRequest.current) setLoadingChatId(null)
    }
  }, [api, user.id])

  useEffect(() => {
    let active = true

    void api.getChats()
      .then((nextChats) => {
        if (!active) return

        setChats(nextChats)
        const lastChatId = localStorage.getItem(lastChatStorageKey(user.id))
        const lastChat = nextChats.find((chat) => chat.id === lastChatId)

        if (lastChat) {
          void selectChat(lastChat)
        } else if (lastChatId) {
          localStorage.removeItem(lastChatStorageKey(user.id))
        }
      })
      .catch((error: unknown) => {
        if (active) setChatsError(getErrorMessage(error))
      })
      .finally(() => {
        if (active) setLoadingChats(false)
      })

    return () => {
      active = false
      selectionRequest.current += 1
    }
  }, [api, selectChat, user.id])

  useEffect(() => {
    let active = true

    void messenger.loadMailbox()
      .then(({ messages: receivedMessages }) => {
        if (active) setMessages(receivedMessages)
      })
      .catch((error: unknown) => {
        if (active) setMailboxError(getErrorMessage(error))
      })
      .finally(() => {
        if (active) setLoadingMailbox(false)
      })

    return () => {
      active = false
    }
  }, [messenger])

  async function findPeople(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSearching(true)
    setSearchError(null)

    try {
      setSearchResults(await api.searchUsers(search.trim()))
    } catch (error) {
      setSearchResults(null)
      setSearchError(getErrorMessage(error))
    } finally {
      setSearching(false)
    }
  }

  async function openDirectChat(otherUser: User) {
    setOpeningUserId(otherUser.id)
    setSearchError(null)

    try {
      const chat = await api.createDirectChat(otherUser.id)
      selectionRequest.current += 1
      setChats((current) => upsertChat(current, chat))
      setSelectedChat(chat)
      localStorage.setItem(lastChatStorageKey(user.id), chat.id)
      setChatsError(null)
      setSearch('')
      setSearchResults(null)
    } catch (error) {
      setSearchError(getErrorMessage(error))
    } finally {
      setOpeningUserId(null)
    }
  }

  async function sendText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedChat || !draft.trim() || sending) return

    const chat = selectedChat
    const content = draft
    setSending(true)
    setSendError(null)

    try {
      const accepted = await messenger.sendText(chat.id, content)
      setMessages((current) => [
        ...current.filter((message) => message.messageId !== accepted.id),
        {
          messageId: accepted.id,
          chatId: accepted.chat_id,
          senderUserId: accepted.sender_user_id,
          content,
          createdAt: accepted.created_at,
        },
      ])
      setDraft('')
    } catch (error) {
      setSendError(getErrorMessage(error))
    } finally {
      setSending(false)
    }
  }

  const selectedMessages = selectedChat
    ? messages.filter((message) => message.chatId === selectedChat.id)
    : []

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar" aria-label="Direct chats">
        <div className="sidebar-profile">
          <div className="avatar compact" aria-hidden="true">
            {user.username.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <span>Signed in as</span>
            <strong>{user.username}</strong>
          </div>
        </div>

        <section className="people-search" aria-labelledby="people-heading">
          <div className="sidebar-heading">
            <div>
              <p className="eyebrow">New conversation</p>
              <h1 id="people-heading">Find people</h1>
            </div>
          </div>
          <form className="search-form" role="search" onSubmit={findPeople}>
            <label className="sr-only" htmlFor="people-search">Search by username</label>
            <input
              id="people-search"
              name="search"
              type="search"
              placeholder="Search username"
              autoComplete="off"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button className="search-button" type="submit" disabled={searching}>
              {searching ? 'Searching...' : 'Search'}
            </button>
          </form>

          {searchError && <p className="compact-error" role="alert">{searchError}</p>}
          {searchResults !== null && (
            <div className="search-results" aria-live="polite">
              <p>{searchResults.length === 0 ? 'No people found.' : 'Search results'}</p>
              {searchResults.length > 0 && (
                <ul>
                  {searchResults.map((person) => (
                    <li key={person.id}>
                      <button
                        type="button"
                        disabled={openingUserId !== null}
                        onClick={() => openDirectChat(person)}
                        aria-label={`Open a direct chat with ${person.username}`}
                      >
                        <span className="person-avatar" aria-hidden="true">
                          {person.username.slice(0, 1).toUpperCase()}
                        </span>
                        <span><strong>{person.username}</strong><small>Open direct chat</small></span>
                        <span aria-hidden="true">
                          {openingUserId === person.id ? '...' : '+'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        <section className="chat-list-section" aria-labelledby="chats-heading">
          <div className="sidebar-heading">
            <h2 id="chats-heading">Direct chats</h2>
            {!loadingChats && <span className="count-pill">{chats.length}</span>}
          </div>
          {chatsError && <p className="compact-error" role="alert">{chatsError}</p>}
          {loadingChats ? (
            <p className="sidebar-empty" aria-live="polite">Loading chats...</p>
          ) : chats.length === 0 ? (
            <p className="sidebar-empty">Search for someone to start a private chat.</p>
          ) : (
            <ul className="chat-list">
              {chats.map((chat) => (
                <li key={chat.id}>
                  <button
                    type="button"
                    className={selectedChat?.id === chat.id ? 'selected' : ''}
                    aria-current={selectedChat?.id === chat.id ? 'page' : undefined}
                    onClick={() => selectChat(chat)}
                  >
                    <span className="person-avatar" aria-hidden="true">
                      {chat.other_user.username.slice(0, 1).toUpperCase()}
                    </span>
                    <span>
                      <strong>{chat.other_user.username}</strong>
                      <small>{loadingChatId === chat.id ? 'Opening...' : 'Direct chat'}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>

      <section className="chat-stage" aria-labelledby="selected-chat-heading">
        {selectedChat ? (
          <>
            <header className="chat-stage-header">
              <div className="person-avatar large" aria-hidden="true">
                {selectedChat.other_user.username.slice(0, 1).toUpperCase()}
              </div>
              <div>
                <p className="eyebrow">Direct chat</p>
                <h2 id="selected-chat-heading">{selectedChat.other_user.username}</h2>
              </div>
              <span className="secure-pill">Private</span>
            </header>
            <div className="message-stage">
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
                  <p>Send the first message to {selectedChat.other_user.username}.</p>
                  <small>Chat created {formatDate(selectedChat.created_at)}</small>
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
            <form className="message-composer" onSubmit={sendText}>
              <label className="sr-only" htmlFor="message-draft">Message</label>
              <textarea
                id="message-draft"
                name="message"
                rows={2}
                placeholder={`Message ${selectedChat.other_user.username}`}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={sending}
              />
              <button type="submit" disabled={sending || !draft.trim()}>
                {sending ? 'Sending...' : 'Send'}
              </button>
              {sendError && <p className="compact-error" role="alert">{sendError}</p>}
            </form>
          </>
        ) : (
          <div className="chat-empty-state no-selection">
            <div className="empty-bubbles" aria-hidden="true">...</div>
            <h2 id="selected-chat-heading">Choose a conversation</h2>
            <p>Select a direct chat or find someone new by username.</p>
          </div>
        )}
      </section>
    </div>
  )
}
