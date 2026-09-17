import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ChatPreferencesService, createChatStore,
  type ChatGateway, type ChatStoreDependencies, type DirectChat, type MailboxLoadResult,
  type ReceivedMessage, type SentMessage, type User,
} from '../src/index.ts'

const timestamp = '2026-09-14T00:00:00Z'
const chats: DirectChat[] = ['bob', 'carol'].map((name) => ({
  id: `${name}-chat`, type: 'DIRECT', createdAt: timestamp,
  otherUser: { id: `${name}-id`, username: name, status: 'active', createdAt: timestamp },
}))
const discovered: DirectChat = { ...chats[0], id: 'discovered-chat' }

function message(id = 'message-1', chatId = chats[0].id): ReceivedMessage {
  return {
    messageId: id, chatId, senderUserId: 'alice', content: id, createdAt: timestamp,
    envelopeId: `envelope-${id}`, senderDeviceId: 'device', clientMessageId: `client-${id}`, mailboxSeq: 1,
  }
}

function mailbox(messages: ReceivedMessage[] = []): MailboxLoadResult {
  return { messages, nextSeq: messages.length, tombstoneCount: 0 }
}

function accepted(chatId: string): SentMessage {
  return {
    id: 'accepted', chatId, senderUserId: 'alice', senderDeviceId: 'device',
    clientMessageId: 'client-id', createdAt: timestamp, envelopes: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function setup() {
  const calls: string[] = []
  const saved = new Map<string, string>()
  const writes: Array<[string, string | null]> = []
  const storage = {
    async getLastChatId(userId: string) { return saved.get(userId) ?? null },
    async setLastChatId(userId: string, chatId: string | null) {
      writes.push([userId, chatId])
      if (chatId) saved.set(userId, chatId)
      else saved.delete(userId)
    },
  }
  const preferences = new ChatPreferencesService(storage)
  const gateway: ChatGateway = {
    async getChats() { calls.push('chats'); return chats },
    async getChat(id) {
      calls.push(`chat:${id}`)
      const chat = [...chats, discovered].find((candidate) => candidate.id === id)
      assert.ok(chat)
      return chat
    },
    async searchUsers(query) { calls.push(`search:${query}`); return [chats[0].otherUser] },
    async createDirectChat(userId) { calls.push(`create:${userId}`); return chats[0] },
  }
  const listeners = new Map<(message: ReceivedMessage) => void, (error: unknown) => void>()
  const readyListeners = new Set<() => void>()
  const sent: Array<{ chatId: string; content: string }> = []
  const messenger: ChatStoreDependencies['messenger'] = {
    async loadMailbox() { calls.push('mailbox'); return mailbox() },
    subscribe(onMessage, onError) {
      listeners.set(onMessage, onError)
      return () => { listeners.delete(onMessage) }
    },
    onReady(handler) { readyListeners.add(handler); return () => { readyListeners.delete(handler) } },
    async sendText(chatId, content) { sent.push({ chatId, content }); return accepted(chatId) },
  }
  const store = createChatStore({ chats: gateway, messenger, preferences })
  const receive = (value: ReceivedMessage) => { for (const handler of listeners.keys()) handler(value) }
  const ready = () => { for (const handler of readyListeners) handler() }
  return { store, gateway, messenger, storage, preferences, calls, saved, writes, listeners, readyListeners, sent, receive, ready }
}

test('startup loads chats and mailbox and restores only the current user preference with fresh details', async () => {
  const { store, gateway, saved, calls } = setup()
  saved.set('alice', chats[1].id)
  saved.set('another-user', chats[0].id)
  const freshChat = { ...chats[1], otherUser: { ...chats[1].otherUser, username: 'updated' } }
  gateway.getChat = async (id) => { calls.push(`chat:${id}`); return freshChat }
  await store.getState().start('alice')
  assert.equal(store.getState().userId, 'alice')
  assert.equal(store.getState().selectedChat, freshChat)
  assert.equal(store.getState().chats[1], freshChat)
  assert.equal(store.getState().loadingChats, false)
  assert.equal(store.getState().loadingMailbox, false)
  assert.deepEqual(calls, ['chats', 'mailbox', `chat:${chats[1].id}`])
  assert.equal(saved.get('another-user'), chats[0].id)
})

test('a missing or deleted last chat leaves no selection and removes only the stale preference', async () => {
  for (const savedChat of [null, 'deleted']) {
    const { store, saved, calls } = setup()
    if (savedChat) saved.set('alice', savedChat)
    saved.set('other-user', chats[1].id)
    await store.getState().start('alice')
    assert.equal(store.getState().selectedChat, null)
    assert.equal(saved.has('alice'), false)
    assert.equal(saved.get('other-user'), chats[1].id)
    assert.deepEqual(calls, ['chats', 'mailbox'])
  }
})

test('chat and preference failures finish loading and retain independent mailbox state', async () => {
  for (const stage of ['chats', 'preference']) {
    const { store, gateway, storage } = setup()
    if (stage === 'chats') gateway.getChats = async () => { throw new Error('Chats failed') }
    else storage.getLastChatId = async () => { throw new Error('Storage failed') }
    await store.getState().start('alice')
    assert.equal(store.getState().loadingChats, false)
    assert.equal(store.getState().chatsError, stage === 'chats' ? 'Chats failed' : 'Storage failed')
    assert.equal(store.getState().loadingMailbox, false)
    assert.equal(store.getState().mailboxError, null)
  }
})

test('late selection successes and failures cannot overwrite a newer selection or preference', async () => {
  for (const fails of [false, true]) {
    const { store, gateway, saved } = setup()
    await store.getState().start('alice')
    const late = deferred<DirectChat>()
    const getChat = gateway.getChat
    gateway.getChat = (id) => id === chats[0].id ? late.promise : getChat(id)
    const first = store.getState().selectChat(chats[0])
    await flush()
    await store.getState().selectChat(chats[1])
    if (fails) late.reject(new Error('Stale selection failed'))
    else late.resolve(chats[0])
    await first
    assert.equal(store.getState().selectedChat, chats[1])
    assert.equal(store.getState().loadingChatId, null)
    assert.equal(store.getState().chatsError, null)
    assert.equal(saved.get('alice'), chats[1].id)
  }
})

test('failed selection clears its preference and displays a storage cleanup failure when necessary', async () => {
  for (const storageFails of [false, true]) {
    const { store, gateway, storage, saved } = setup()
    await store.getState().start('alice')
    gateway.getChat = async () => { throw new Error('Chat unavailable') }
    const write = storage.setLastChatId
    storage.setLastChatId = async (userId, chatId) => {
      if (chatId === null && storageFails) throw new Error('Storage unavailable')
      await write(userId, chatId)
    }
    await store.getState().selectChat(chats[0])
    assert.equal(store.getState().selectedChat, null)
    assert.equal(store.getState().loadingChatId, null)
    assert.equal(store.getState().chatsError, storageFails ? 'Storage unavailable' : 'Chat unavailable')
    if (!storageFails) assert.equal(saved.has('alice'), false)
  }
})

test('a delayed preference restoration cannot overwrite manual selection or report an old failure', async () => {
  for (const fails of [false, true]) {
    const { store, preferences, saved } = setup()
    const late = deferred<DirectChat | null>()
    preferences.restore = () => late.promise
    const starting = store.getState().start('alice')
    await flush()
    await store.getState().selectChat(chats[1])
    if (fails) late.reject(new Error('Old preference failed'))
    else late.resolve(chats[0])
    await starting
    assert.equal(store.getState().selectedChat, chats[1])
    assert.equal(store.getState().chatsError, null)
    assert.equal(saved.get('alice'), chats[1].id)
  }
})

test('search trims the query and ignores older results and failures', async () => {
  for (const fails of [false, true]) {
    const { store, gateway, calls } = setup()
    await store.getState().start('alice')
    const late = deferred<User[]>()
    gateway.searchUsers = async (query) => {
      calls.push(`search:${query}`)
      return query === 'bob' ? late.promise : [chats[1].otherUser]
    }
    store.getState().setSearch('  bob  ')
    const first = store.getState().findPeople()
    store.getState().setSearch('carol')
    await store.getState().findPeople()
    if (fails) late.reject(new Error('Old search failed'))
    else late.resolve([chats[0].otherUser])
    await first
    assert.deepEqual(store.getState().searchResults, [chats[1].otherUser])
    assert.equal(store.getState().searchError, null)
    assert.equal(store.getState().searching, false)
    assert.ok(calls.includes('search:bob'))
  }
})

test('search errors clear results and permit retry including empty results', async () => {
  const { store, gateway } = setup()
  await store.getState().start('alice')
  await store.getState().findPeople()
  gateway.searchUsers = async () => { throw new Error('Search failed') }
  await store.getState().findPeople()
  assert.equal(store.getState().searchResults, null)
  assert.equal(store.getState().searchError, 'Search failed')
  assert.equal(store.getState().searching, false)
  gateway.searchUsers = async () => []
  await store.getState().findPeople()
  assert.deepEqual(store.getState().searchResults, [])
  assert.equal(store.getState().searchError, null)
})

test('direct creation upserts, selects and persists the chat and clears the search', async () => {
  const { store, gateway, saved } = setup()
  await store.getState().start('alice')
  store.getState().setSearch('bob')
  await store.getState().findPeople()
  const late = deferred<DirectChat>()
  let creates = 0
  gateway.createDirectChat = async () => { creates += 1; return late.promise }
  const opening = store.getState().openDirectChat(chats[0].otherUser.id)
  assert.equal(store.getState().openingUserId, chats[0].otherUser.id)
  await store.getState().openDirectChat(chats[0].otherUser.id)
  assert.equal(creates, 1)
  late.resolve(chats[0])
  await opening
  assert.equal(store.getState().selectedChat, chats[0])
  assert.equal(store.getState().chats.length, 2)
  assert.equal(saved.get('alice'), chats[0].id)
  assert.equal(store.getState().search, '')
  assert.equal(store.getState().searchResults, null)
  assert.equal(store.getState().openingUserId, null)
})

test('a pending direct creation cannot override a later manual selection', async () => {
  const { store, gateway, saved } = setup()
  await store.getState().start('alice')
  const late = deferred<DirectChat>()
  gateway.createDirectChat = () => late.promise
  const opening = store.getState().openDirectChat('new-user')
  await store.getState().selectChat(chats[1])
  late.resolve(discovered)
  await opening
  assert.ok(store.getState().chats.some((chat) => chat.id === discovered.id))
  assert.equal(store.getState().selectedChat, chats[1])
  assert.equal(saved.get('alice'), chats[1].id)
  assert.equal(store.getState().openingUserId, null)
})

test('direct creation invalidates old selections and pending search results', async () => {
  const { store, gateway } = setup()
  await store.getState().start('alice')
  const lateSelection = deferred<DirectChat>()
  const lateSearch = deferred<User[]>()
  gateway.getChat = () => lateSelection.promise
  gateway.searchUsers = () => lateSearch.promise
  const selecting = store.getState().selectChat(chats[1])
  const searching = store.getState().findPeople()
  await flush()
  await store.getState().openDirectChat(chats[0].otherUser.id)
  lateSelection.resolve(chats[1])
  lateSearch.resolve([chats[1].otherUser])
  await Promise.all([selecting, searching])
  assert.equal(store.getState().selectedChat, chats[0])
  assert.equal(store.getState().loadingChatId, null)
  assert.equal(store.getState().searchResults, null)
  assert.equal(store.getState().searching, false)
})

test('direct creation and persistence errors are placed in search state and clear the busy flag', async () => {
  for (const stage of ['create', 'storage']) {
    const { store, gateway, storage } = setup()
    await store.getState().start('alice')
    if (stage === 'create') gateway.createDirectChat = async () => { throw new Error('Create failed') }
    else storage.setLastChatId = async () => { throw new Error('Save failed') }
    await store.getState().openDirectChat(chats[0].otherUser.id)
    assert.equal(store.getState().searchError, stage === 'create' ? 'Create failed' : 'Save failed')
    assert.equal(store.getState().openingUserId, null)
  }
})

test('live duplicates and accepted sends survive a late initial mailbox without duplication', async () => {
  const { store, messenger, receive } = setup()
  const late = deferred<MailboxLoadResult>()
  messenger.loadMailbox = () => late.promise
  const starting = store.getState().start('alice')
  await flush()
  await store.getState().selectChat(chats[0])
  receive(message('live'))
  receive({ ...message('live'), envelopeId: 'duplicate-envelope' })
  assert.equal(await store.getState().sendText('hello'), true)
  late.resolve(mailbox([message('old'), message('live'), { ...message('accepted'), content: 'hello' }]))
  await starting
  assert.equal(store.getState().messages.length, 3)
  assert.deepEqual(new Set(store.getState().messages.map((value) => value.messageId)), new Set(['live', 'old', 'accepted']))
  assert.equal(store.getState().messages.find((value) => value.messageId === 'accepted')?.content, 'hello')
})

test('discovered chats are fetched once and survive an older chat-list response', async () => {
  const { store, gateway, receive, calls } = setup()
  const late = deferred<DirectChat[]>()
  gateway.getChats = () => late.promise
  const starting = store.getState().start('alice')
  receive(message('live', discovered.id))
  receive(message('duplicate', discovered.id))
  await flush()
  assert.equal(store.getState().chats[0], discovered)
  late.resolve(chats)
  await starting
  assert.equal(store.getState().chats[0], discovered)
  assert.equal(store.getState().chats.length, 3)
  assert.equal(calls.filter((call) => call === `chat:${discovered.id}`).length, 1)
})

test('discovery failure retains the message and allows retry on a later envelope', async () => {
  const { store, gateway, receive } = setup()
  await store.getState().start('alice')
  gateway.getChat = async () => { throw new Error('Discovery failed') }
  receive(message('live', discovered.id))
  await flush()
  assert.equal(store.getState().messages.length, 1)
  assert.equal(store.getState().chatsError, 'Discovery failed')
  gateway.getChat = async () => discovered
  receive(message('next', discovered.id))
  await flush()
  assert.equal(store.getState().chats[0], discovered)
})

test('ready events during a mailbox load coalesce into exactly one following reload', async () => {
  const { store, messenger, ready } = setup()
  const first = deferred<MailboxLoadResult>()
  const second = deferred<MailboxLoadResult>()
  let loads = 0
  messenger.loadMailbox = () => ++loads === 1 ? first.promise : second.promise
  const starting = store.getState().start('alice')
  ready(); ready(); ready()
  assert.equal(loads, 1)
  first.resolve(mailbox([message('first')]))
  await starting
  assert.equal(loads, 2)
  second.resolve(mailbox([message('second')]))
  await flush()
  assert.equal(loads, 2)
  assert.equal(store.getState().messages.length, 2)
  assert.equal(store.getState().loadingMailbox, false)
})

test('mailbox and live decoding errors are surfaced and a successful reload clears the mailbox error', async () => {
  const { store, messenger, listeners } = setup()
  messenger.loadMailbox = async () => { throw new Error('Mailbox failed') }
  await store.getState().start('alice')
  assert.equal(store.getState().mailboxError, 'Mailbox failed')
  assert.equal(store.getState().loadingMailbox, false)
  for (const onError of listeners.values()) onError(new Error('Decode failed'))
  assert.equal(store.getState().mailboxError, 'Decode failed')
  messenger.loadMailbox = async () => mailbox()
  await store.getState().reloadMailbox()
  assert.equal(store.getState().mailboxError, null)
})

test('send preserves content and destination and rejects empty or duplicate submissions', async () => {
  const { store, messenger, sent } = setup()
  await store.getState().start('alice')
  assert.equal(await store.getState().sendText('no selection'), false)
  await store.getState().selectChat(chats[0])
  assert.equal(await store.getState().sendText('  '), false)
  const late = deferred<SentMessage>()
  messenger.sendText = async (chatId, content) => { sent.push({ chatId, content }); return late.promise }
  const sending = store.getState().sendText('  hello\n')
  assert.equal(store.getState().sending, true)
  assert.equal(await store.getState().sendText('duplicate'), false)
  await store.getState().selectChat(chats[1])
  late.resolve(accepted(chats[0].id))
  assert.equal(await sending, true)
  assert.deepEqual(sent, [{ chatId: chats[0].id, content: '  hello\n' }])
  assert.equal(store.getState().messages[0].chatId, chats[0].id)
  assert.equal(store.getState().messages[0].content, '  hello\n')
  assert.equal(store.getState().sending, false)
})

test('send failure permits retry and does not place an old-chat error on a new selection', async () => {
  for (const changeSelection of [false, true]) {
    const { store, messenger } = setup()
    await store.getState().start('alice')
    await store.getState().selectChat(chats[0])
    const late = deferred<SentMessage>()
    messenger.sendText = () => late.promise
    const sending = store.getState().sendText('hello')
    if (changeSelection) await store.getState().selectChat(chats[1])
    late.reject(new Error('Send failed'))
    assert.equal(await sending, false)
    assert.equal(store.getState().sendError, changeSelection ? null : 'Send failed')
    assert.equal(store.getState().sending, false)
    assert.deepEqual(store.getState().messages, [])
    messenger.sendText = async (id) => accepted(id)
    assert.equal(await store.getState().sendText('retry'), true)
    assert.equal(store.getState().sendError, null)
  }
})

test('session replacement clears data and ignores old initial loads and queued reconnect reloads', async () => {
  const { store, gateway, messenger, ready, calls } = setup()
  const oldChats = deferred<DirectChat[]>()
  const oldMailbox = deferred<MailboxLoadResult>()
  gateway.getChats = () => oldChats.promise
  messenger.loadMailbox = () => oldMailbox.promise
  const oldStart = store.getState().start('alice')
  ready()
  gateway.getChats = async () => []
  messenger.loadMailbox = async () => { calls.push('new-mailbox'); return mailbox() }
  await store.getState().start('other-user')
  const current = store.getState()
  oldChats.resolve(chats)
  oldMailbox.resolve(mailbox([message()]))
  await oldStart
  await flush()
  assert.equal(store.getState(), current)
  assert.equal(current.userId, 'other-user')
  assert.deepEqual(current.chats, [])
  assert.deepEqual(current.messages, [])
  assert.deepEqual(calls, ['new-mailbox'])
})

test('late selection, search, creation, send and discovery results cannot change the next session', async () => {
  for (const stage of ['select', 'search', 'create', 'send', 'discover']) {
    for (const fails of [false, true]) {
      const { store, gateway, messenger, receive, writes } = setup()
      await store.getState().start('alice')
      await store.getState().selectChat(chats[0])
      const late = deferred<never>()
      let pending: Promise<unknown> = Promise.resolve()
      if (stage === 'select') {
        gateway.getChat = () => late.promise
        pending = store.getState().selectChat(chats[1])
      } else if (stage === 'search') {
        gateway.searchUsers = () => late.promise
        pending = store.getState().findPeople()
      } else if (stage === 'create') {
        gateway.createDirectChat = () => late.promise
        pending = store.getState().openDirectChat('other')
      } else if (stage === 'send') {
        messenger.sendText = () => late.promise
        pending = store.getState().sendText('hello')
      } else {
        gateway.getChat = () => late.promise
        receive(message('live', discovered.id))
      }
      await flush()
      await store.getState().start('another-session')
      const current = store.getState()
      const previousWrites = [...writes]
      if (fails) late.reject(new Error('Old operation failed'))
      else late.resolve((stage === 'search' ? [chats[1].otherUser] : stage === 'send' ? accepted(chats[0].id) : chats[1]) as never)
      await pending
      await flush()
      assert.equal(store.getState(), current, stage)
      assert.deepEqual(writes, previousWrites, stage)
    }
  }
})

test('disposal releases subscriptions, clears all state and makes old callbacks harmless after restart', async () => {
  const { store, receive, listeners, readyListeners } = setup()
  await store.getState().start('alice')
  await store.getState().selectChat(chats[0])
  store.getState().setSearch('bob')
  await store.getState().findPeople()
  receive(message())
  await flush()
  const oldReceive = [...listeners.keys()][0]
  const oldError = [...listeners.values()][0]
  const oldReady = [...readyListeners][0]
  store.getState().dispose()
  store.getState().dispose()
  assert.equal(listeners.size, 0)
  assert.equal(readyListeners.size, 0)
  assert.equal(store.getState().userId, null)
  assert.deepEqual(store.getState().messages, [])
  assert.deepEqual(store.getState().chats, [])
  assert.equal(store.getState().selectedChat, null)
  assert.equal(store.getState().search, '')
  assert.equal(store.getState().searchResults, null)
  await store.getState().start('alice')
  assert.equal(listeners.size, 1)
  assert.equal(readyListeners.size, 1)
  const current = store.getState()
  oldReceive(message('late'))
  oldError(new Error('Late decode failed'))
  oldReady()
  await flush()
  assert.equal(store.getState(), current)
})
