import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  getErrorMessage,
  type ApiClient,
  type CurrentUser,
  type DirectChat,
  type User,
} from '../../../shared/api'

type ChatWorkspaceProps = {
  api: ApiClient
  user: CurrentUser
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

function upsertChat(chats: DirectChat[], chat: DirectChat): DirectChat[] {
  const existingIndex = chats.findIndex((candidate) => candidate.id === chat.id)
  if (existingIndex === -1) return [chat, ...chats]

  const nextChats = [...chats]
  nextChats[existingIndex] = chat
  return nextChats
}

export function ChatWorkspace({ api, user }: ChatWorkspaceProps) {
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
  const selectionRequest = useRef(0)

  useEffect(() => {
    let active = true

    void api.getChats()
      .then((nextChats) => {
        if (active) setChats(nextChats)
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
  }, [api])

  async function selectChat(chat: DirectChat) {
    const request = selectionRequest.current + 1
    selectionRequest.current = request
    setSelectedChat(chat)
    setLoadingChatId(chat.id)
    setChatsError(null)

    try {
      const freshChat = await api.getChat(chat.id)
      if (request !== selectionRequest.current) return
      setSelectedChat(freshChat)
      setChats((current) => upsertChat(current, freshChat))
    } catch (error) {
      if (request !== selectionRequest.current) return
      setSelectedChat(null)
      setChatsError(getErrorMessage(error))
    } finally {
      if (request === selectionRequest.current) setLoadingChatId(null)
    }
  }

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
      setChatsError(null)
      setSearch('')
      setSearchResults(null)
    } catch (error) {
      setSearchError(getErrorMessage(error))
    } finally {
      setOpeningUserId(null)
    }
  }

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
            <div className="chat-empty-state">
              <div className="empty-lock" aria-hidden="true">S</div>
              <h3>Chat ready</h3>
              <p>
                Your direct chat with {selectedChat.other_user.username} is open. Secure messaging
                will appear here in the next version.
              </p>
              <small>Created {formatDate(selectedChat.created_at)}</small>
            </div>
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
