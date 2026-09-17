import type { CurrentUser } from '@secure-messenger/client-core'
import type { FormEvent } from 'react'
import { useChatStore } from '../../../shared/application/clientContext'

export function ChatSidebar({ user }: { user: CurrentUser }) {
  const {
    chats, selectedChat, loadingChats, loadingChatId, chatsError, search, searchResults,
    searching, searchError, openingUserId, selectChat, setSearch, findPeople, openDirectChat,
  } = useChatStore((state) => state)

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void findPeople()
  }

  return (
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
        <form className="search-form" role="search" onSubmit={handleSearch}>
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
                      onClick={() => openDirectChat(person.id)}
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
                    {chat.otherUser.username.slice(0, 1).toUpperCase()}
                  </span>
                  <span>
                    <strong>{chat.otherUser.username}</strong>
                    <small>{loadingChatId === chat.id ? 'Opening...' : 'Direct chat'}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}
