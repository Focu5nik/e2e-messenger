import assert from 'node:assert/strict'
import { after, afterEach, beforeEach, mock, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { ChatPreferencesService, ClientError, createChatStore, createSessionStore, DeviceIdentityService, MessengerService, PlaintextMessageCodec } from '@secure-messenger/client-core'
import type { CurrentUserDto, DeviceDto, DeviceIdentity, DirectChatDto, MailboxEnvelope, RealtimeGateway } from '@secure-messenger/client-core'
import { mailboxEnvelopeDto, sentMessageDto } from './apiFixtures.ts'
import { browserDeviceDescription } from '../src/shared/platform/deviceDescription.ts'
import { browserIdGenerator, browserTextEncoding } from '../src/shared/platform/messaging.ts'
import { browserChatPreferencesStore, browserDeviceIdentityStore } from '../src/shared/platform/storage.ts'

// Install the DOM before loading React DOM so its event system detects a browser.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:5173',
})
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
}

const { act, StrictMode } = await import('react')
const { createRoot } = await import('react-dom/client')
const { default: App } = await import('../src/app/App.tsx')
const { WebClientProvider } = await import('../src/shared/application/WebClientProvider.tsx')
const { apiClient, checkBackendHealth } = await import('../src/shared/api/client.ts')

const identity = { id: '00000000-0000-4000-8000-000000000001', name: 'Test browser' }
const user: CurrentUserDto = {
  id: 'alice-id', username: 'alice', status: 'active', created_at: '2026-09-01T00:00:00Z',
  device_id: identity.id, session_id: 'session-id',
}
const devices: DeviceDto[] = [
  { id: identity.id, name: identity.name, is_current: true },
  { id: 'remote-id', name: 'Remote browser', is_current: false },
].map((device) => ({
  ...device, protocol_version: 0, created_at: user.created_at,
  last_seen_at: user.created_at, revoked_at: null,
}))
const chats: DirectChatDto[] = ['bob', 'carol'].map((username) => ({
  id: `${username}-chat`, type: 'DIRECT', created_at: user.created_at,
  other_user: { id: `${username}-id`, username, status: 'active', created_at: user.created_at },
}))
const lastChatKey = `messenger.lastChat.${user.id}`
type Request = { path: string; init: RequestInit }
let requests: Request[]
let respond: (request: Request) => Response | Promise<Response> | undefined
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let starts: number
let stops: number
let realtime: RealtimeGateway
let identities: DeviceIdentityService
let preferences: ChatPreferencesService
let messageHandlers: Set<(envelope: MailboxEnvelope) => void>
let readyHandlers: Set<() => void>

function tokens(): Response {
  return Response.json({ access_token: 'test-access', token_type: 'bearer', expires_in: 900 })
}

function errorResponse(detail: string, status: number): Response {
  return Response.json({ detail }, { status })
}

function defaultResponse({ path, init }: Request): Response {
  if (path === '/health') return Response.json({ status: 'ok' })
  if (path === '/auth/refresh' || path === '/auth/login') return tokens()
  if (path === '/auth/register' || path === '/me') return Response.json(user)
  if (path === '/auth/logout' || (path.startsWith('/devices/') && init.method === 'DELETE')) {
    return new Response(null, { status: 204 })
  }
  if (path === '/devices') return Response.json(devices)
  if (path === '/chats') return Response.json(chats)
  const chat = chats.find((candidate) => path === `/chats/${candidate.id}`)
  if (chat) return Response.json(chat)
  if (path === '/messages/mailbox?after_seq=0&limit=100') {
    return Response.json({ envelopes: [], next_seq: 0, has_more: false })
  }
  throw new Error(`Unexpected request: ${init.method ?? 'GET'} ${path}`)
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('messenger.device', JSON.stringify(identity))
  requests = []
  respond = () => undefined
  starts = 0
  stops = 0
  identities = new DeviceIdentityService(browserDeviceIdentityStore, browserIdGenerator, browserDeviceDescription)
  preferences = new ChatPreferencesService(browserChatPreferencesStore)
  // Inject an in-memory gateway; no browser socket is needed by the components.
  messageHandlers = new Set()
  readyHandlers = new Set()
  realtime = {
    ready: false,
    start() { starts += 1 },
    stop() { stops += 1 },
    async sendMessage() { throw new Error('Unexpected realtime send') },
    onMessage(handler) { messageHandlers.add(handler); return () => { messageHandlers.delete(handler) } },
    onReady(handler) { readyHandlers.add(handler); return () => { readyHandlers.delete(handler) } },
  }
  mock.method(window, 'confirm', () => true)
  mock.method(globalThis, 'fetch', async (input: string | URL | globalThis.Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const request = { path: url.pathname + url.search, init }
    requests.push(request)
    return respond(request) ?? defaultResponse(request)
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  // Clear the real API singleton's memory token and refresh timer between tests.
  respond = () => undefined
  await apiClient.logout()
  container.remove()
  mock.restoreAll()
})
after(() => dom.window.close())

function element<T extends Element = HTMLElement>(selector: string): T {
  const result = container.querySelector<T>(selector)
  assert.ok(result, `Missing element: ${selector}`)
  return result
}

function createTestChatStore() {
  const messenger = new MessengerService(apiClient, new PlaintextMessageCodec(browserTextEncoding), browserIdGenerator, realtime)
  return createChatStore({ chats: apiClient, messenger, preferences })
}

async function renderApp(checkHealth = checkBackendHealth) {
  const session = createSessionStore({ session: apiClient, account: apiClient, identities })
  const client = { session, realtime, chatStore: createTestChatStore(), checkHealth }
  await act(async () => root.render(<WebClientProvider client={client}><App /></WebClientProvider>))
  return client
}

test('the provider supplies health checks without coupling App to the HTTP adapter', async () => {
  let online = false
  let checks = 0
  await renderApp(async () => { checks += 1; return online })
  assert.equal(element('.health-status').textContent?.trim(), 'Backend offline')
  online = true
  await click('.health-status')
  assert.equal(element('.health-status').textContent?.trim(), 'Backend online')
  assert.equal(checks, 2)
  assert.equal(requests.some(({ path }) => path === '/health'), false)
})

test('provider rerenders and account navigation preserve chat state and subscriptions', async () => {
  const client = await renderApp()
  await click('.chat-list li:first-child button')
  await act(async () => {
    const draft = element<HTMLTextAreaElement>('#message-draft')
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, 'Unsent draft')
    draft.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  const initialRequests = requests.length
  await act(async () => root.render(<WebClientProvider client={{ ...client }}><App /></WebClientProvider>))
  await click('.primary-nav button:nth-child(2)')
  await click('.primary-nav button:first-child')
  assert.equal(element('#selected-chat-heading').textContent, 'bob')
  assert.equal(element<HTMLTextAreaElement>('#message-draft').value, 'Unsent draft')
  assert.equal(requests.length, initialRequests)
  assert.equal(starts, 1)
  assert.equal(stops, 0)
  assert.equal(messageHandlers.size, 1)
  assert.equal(readyHandlers.size, 1)

  await click('.chat-list li:nth-child(2) button')
  assert.equal(element<HTMLTextAreaElement>('#message-draft').value, 'Unsent draft')
  assert.equal(document.activeElement, element('#message-draft'))
  await act(async () => root.render(null))
  assert.equal(stops, 1)
  assert.equal(messageHandlers.size, 0)
  assert.equal(readyHandlers.size, 0)
  assert.equal(client.chatStore.getState().selectedChat, null)
})

test('the composer preserves Enter, Shift+Enter and composition handling and scrolls live messages', async () => {
  respond = ({ path }) => {
    if (path === '/chats/bob-chat/destination-devices') {
      return Response.json([{ id: identity.id, protocol_version: 0 }])
    }
    if (path === '/messages') return Response.json({ ...sentMessageDto, chat_id: 'bob-chat', sender_user_id: user.id })
  }
  await renderApp()
  await click('.chat-list li:first-child button')
  const draft = element<HTMLTextAreaElement>('#message-draft')
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, 'hello')
    draft.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  for (const options of [{ shiftKey: true }, { isComposing: true }]) {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options })
    await act(async () => { draft.dispatchEvent(event) })
    assert.equal(event.defaultPrevented, false)
    assert.equal(requests.some(({ path }) => path === '/messages'), false)
  }
  const stage = element<HTMLDivElement>('.message-stage')
  Object.defineProperty(stage, 'scrollHeight', { configurable: true, value: 200 })
  const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  await act(async () => { draft.dispatchEvent(enter) })
  assert.equal(enter.defaultPrevented, true)
  assert.equal(requests.filter(({ path }) => path === '/messages').length, 1)
  assert.equal(draft.value, '')
  assert.equal(document.activeElement, draft)
  assert.equal(stage.scrollTop, 200)

  Object.defineProperty(stage, 'scrollHeight', { configurable: true, value: 400 })
  await act(async () => {
    for (const handler of messageHandlers) handler({
      ...mailboxEnvelopeDto, chat_id: 'bob-chat', message_id: 'another-message',
    })
  })
  assert.equal(container.querySelectorAll('.message').length, 2)
  assert.equal(stage.scrollTop, 400)
})

test('App waits for device identity storage before restoring the session', async () => {
  let resolveRead!: (value: unknown) => void
  mock.method(browserDeviceIdentityStore, 'read', () => new Promise((resolve) => { resolveRead = resolve }))
  await renderApp()
  assert.match(container.textContent!, /Restoring your secure session/)
  assert.equal(requests.some(({ path }) => path === '/auth/refresh'), false)
  await act(async () => resolveRead(identity))
  assert.ok(container.querySelector('.shell'))
})

test('an identity read completing after unmount does not restore a session', async () => {
  let resolveRead!: (value: unknown) => void
  mock.method(browserDeviceIdentityStore, 'read', () => new Promise((resolve) => { resolveRead = resolve }))
  await renderApp()
  await act(async () => root.render(null))
  await act(async () => resolveRead(identity))
  assert.equal(requests.some(({ path }) => path === '/auth/refresh'), false)
  assert.equal(starts, 0)
})

test('revoked-device recovery waits for replacement persistence before retrying login', async () => {
  respond = anonymousRestore
  await renderApp()
  const write = browserDeviceIdentityStore.write
  let releaseWrite!: () => void
  mock.method(browserDeviceIdentityStore, 'write', async (value: DeviceIdentity) => {
    await new Promise<void>((resolve) => { releaseWrite = resolve })
    await write(value)
  })
  respond = ({ path }) => path === '/auth/login' && loginBodies().length === 1
    ? errorResponse('device is revoked', 403) : undefined
  await submitCredentials()
  assert.equal(loginBodies().length, 1)
  assert.equal(JSON.parse(localStorage.getItem('messenger.device')!).id, identity.id)
  await act(async () => releaseWrite())
  assert.equal(loginBodies().length, 2)
  assert.equal(loginBodies()[1].device_id, JSON.parse(localStorage.getItem('messenger.device')!).id)
  assert.notEqual(loginBodies()[1].device_id, identity.id)
  assert.ok(container.querySelector('.shell'))
})

test('delayed preference restoration cannot overwrite a manually selected chat', async () => {
  let resolveRead!: (value: string) => void
  mock.method(browserChatPreferencesStore, 'getLastChatId', () => new Promise((resolve) => { resolveRead = resolve }))
  await renderApp()
  await click('.chat-list li:nth-child(2) button')
  assert.equal(element('#selected-chat-heading').textContent, 'carol')
  await act(async () => resolveRead('bob-chat'))
  assert.equal(element('#selected-chat-heading').textContent, 'carol')
  assert.equal(localStorage.getItem(lastChatKey), 'carol-chat')
  assert.equal(requests.some(({ path }) => path === '/chats/bob-chat'), false)
})

test('a late preference read failure does not put an error on a newer selection', async () => {
  let rejectRead!: (error: Error) => void
  mock.method(browserChatPreferencesStore, 'getLastChatId', () => new Promise((_, reject) => { rejectRead = reject }))
  await renderApp()
  await click('.chat-list li:nth-child(2) button')
  await act(async () => rejectRead(new Error('Old preference read failed')))
  assert.equal(element('#selected-chat-heading').textContent, 'carol')
  assert.equal(localStorage.getItem(lastChatKey), 'carol-chat')
  assert.equal(container.querySelector('[role="alert"]'), null)
})

test('the injected realtime gateway reaches the workspace and releases subscriptions on logout', async () => {
  localStorage.setItem(lastChatKey, 'bob-chat')
  await renderApp()
  assert.equal(messageHandlers.size, 1)
  assert.equal(readyHandlers.size, 1)
  const mailboxRequests = () => requests.filter(({ path }) => path.startsWith('/messages/mailbox')).length
  const initialLoads = mailboxRequests()
  await act(async () => {
    for (const handler of readyHandlers) handler()
    for (const handler of messageHandlers) handler({ ...mailboxEnvelopeDto, chat_id: 'bob-chat' })
    for (const handler of messageHandlers) handler({ ...mailboxEnvelopeDto, id: 'duplicate-envelope', chat_id: 'bob-chat' })
  })
  assert.equal(mailboxRequests(), initialLoads + 1)
  assert.equal(element('.message p').textContent, 'hi')
  assert.equal(container.querySelectorAll('.message').length, 1)
  await click('.header-actions .secondary-button')
  assert.equal(stops, 1)
  assert.equal(messageHandlers.size, 0)
  assert.equal(readyHandlers.size, 0)
})

test('App releases its session-expiry subscription when unmounted', async () => {
  const subscribe = apiClient.onSessionExpired.bind(apiClient)
  let subscriptions = 0
  let unsubscriptions = 0
  mock.method(apiClient, 'onSessionExpired', (handler: () => void) => {
    subscriptions += 1
    const unsubscribe = subscribe(handler)
    return () => { unsubscriptions += 1; unsubscribe() }
  })
  await renderApp()
  assert.equal(subscriptions, 1)
  assert.equal(unsubscriptions, 0)
  await act(async () => root.render(null))
  assert.equal(unsubscriptions, 1)
})

test('StrictMode reconnects the session store with one active expiry subscription', async () => {
  const subscribe = apiClient.onSessionExpired.bind(apiClient)
  let activeSubscriptions = 0
  mock.method(apiClient, 'onSessionExpired', (handler: () => void) => {
    activeSubscriptions += 1
    const unsubscribe = subscribe(handler)
    return () => { activeSubscriptions -= 1; unsubscribe() }
  })
  const session = createSessionStore({ session: apiClient, account: apiClient, identities })
  await act(async () => root.render(
    <StrictMode><WebClientProvider client={{ session, realtime, chatStore: createTestChatStore(), checkHealth: checkBackendHealth }}><App /></WebClientProvider></StrictMode>,
  ))
  assert.ok(container.querySelector('.shell'))
  assert.equal(activeSubscriptions, 1)
  assert.equal(requests.filter(({ path }) => path === '/auth/refresh').length, 1)
  await act(async () => root.render(null))
  assert.equal(activeSubscriptions, 0)
})

test('successful registration followed by failed login leaves sign-in selected for retry', async () => {
  respond = anonymousRestore
  await renderApp()
  await click('[role="tab"]:nth-child(2)')
  respond = ({ path }) => path === '/auth/login' ? errorResponse('Login unavailable', 503) : undefined
  await submitCredentials()
  assert.equal(element('#auth-title').textContent, 'Welcome back')
  assert.equal(element('[role="alert"]').textContent, 'Login unavailable')
  respond = () => undefined
  await submitCredentials()
  assert.ok(container.querySelector('.shell'))
  assert.equal(requests.filter(({ path }) => path === '/auth/register').length, 1)
})

test('people search and direct-chat creation render store results and clear the search field', async () => {
  respond = ({ path }) => {
    if (path === '/users?search=bob') return Response.json([chats[0].other_user])
    if (path === '/chats/direct/bob-id') return Response.json(chats[0])
  }
  await renderApp()
  await enter('#people-search', '  bob  ')
  await click('.search-button')
  assert.equal(element('.search-results strong').textContent, 'bob')
  await click('[aria-label="Open a direct chat with bob"]')
  assert.equal(element('#selected-chat-heading').textContent, 'bob')
  assert.equal(element<HTMLInputElement>('#people-search').value, '')
  assert.equal(container.querySelector('.search-results'), null)
  assert.equal(localStorage.getItem(lastChatKey), 'bob-chat')
  assert.equal(container.querySelectorAll('.chat-list li').length, 2)
})

test('no recipient devices shows an actionable error, preserves the draft and allows retry when a device appears', async () => {
  let hasDevice = false
  let socketSends = 0
  realtime = {
    ...realtime, ready: true,
    async sendMessage(command) {
      socketSends += 1
      return {
        id: 'accepted-message', chatId: command.chat_id, senderUserId: user.id,
        senderDeviceId: identity.id, clientMessageId: command.client_message_id,
        createdAt: sentMessageDto.created_at, envelopes: [],
      }
    },
  }
  respond = ({ path }) => {
    if (path === '/chats/bob-chat/destination-devices') {
      return Response.json(hasDevice ? [{ id: 'bob-device', protocol_version: 0 }] : [])
    }
  }
  await renderApp()
  await click('.chat-list li:first-child button')
  const draft = element<HTMLTextAreaElement>('#message-draft')
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, 'hello')
    draft.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await click('.message-composer button')
  assert.equal(element('[role="alert"]').textContent,
    'This person has no available devices to receive messages. Try again after they register a device.')
  assert.equal(draft.value, 'hello')
  assert.equal(element<HTMLButtonElement>('.message-composer button').disabled, false)
  assert.equal(container.querySelectorAll('.message').length, 0)
  assert.equal(socketSends, 0)
  assert.equal(requests.some(({ path }) => path === '/messages'), false)

  hasDevice = true
  await click('.message-composer button')
  assert.equal(socketSends, 1)
  assert.equal(draft.value, '')
  assert.equal(container.querySelector('[role="alert"]'), null)
  assert.equal(element('.message p').textContent, 'hello')
})

for (const transport of ['http', 'realtime']) {
  test(`${transport} send keeps the draft on failure, clears it on acceptance and deduplicates the live echo`, async () => {
    let failSend = true
    const sent = { ...sentMessageDto, chat_id: 'bob-chat', sender_user_id: user.id }
    if (transport === 'realtime') {
      realtime = {
        ...realtime, ready: true,
        async sendMessage(command) {
          assert.equal(command.chat_id, 'bob-chat')
          if (failSend) throw new ClientError('Send unavailable', 'server_error')
          return {
            id: sent.id, chatId: sent.chat_id, senderUserId: sent.sender_user_id,
            senderDeviceId: sent.sender_device_id, clientMessageId: command.client_message_id,
            createdAt: sent.created_at, envelopes: sent.envelopes,
          }
        },
      }
    }
    respond = ({ path }) => {
      if (path === '/chats/bob-chat/destination-devices') {
        return Response.json([{ id: identity.id, protocol_version: 0 }])
      }
      if (path === '/messages') return failSend ? errorResponse('Send unavailable', 503) : Response.json(sent)
    }
    await renderApp()
    await click('.chat-list li:first-child button')
    await act(async () => {
      const draft = element<HTMLTextAreaElement>('#message-draft')
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, ' hello ')
      draft.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await click('.message-composer button')
    assert.equal(element('[role="alert"]').textContent, 'Send unavailable')
    assert.equal(element<HTMLTextAreaElement>('#message-draft').value, ' hello ')
    failSend = false
    await click('.message-composer button')
    assert.equal(element<HTMLTextAreaElement>('#message-draft').value, '')
    assert.equal(element('.message p').textContent, ' hello ')
    assert.equal(container.querySelector('[role="alert"]'), null)
    assert.equal(document.activeElement, element('#message-draft'))
    await act(async () => {
      for (const handler of messageHandlers) handler({
        ...mailboxEnvelopeDto, chat_id: sent.chat_id, sender_user_id: user.id,
        payload: Buffer.from(' hello ').toString('base64'),
      })
    })
    assert.equal(container.querySelectorAll('.message').length, 1)
    assert.equal(requests.filter(({ path }) => path === '/messages').length, transport === 'http' ? 2 : 0)
  })
}

async function click(selector: string): Promise<void> {
  await act(async () => element<HTMLElement>(selector).click())
}

async function enter(selector: string, value: string): Promise<void> {
  await act(async () => {
    const input = element<HTMLInputElement>(selector)
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

async function submitCredentials(): Promise<void> {
  await enter('#username', '  alice  ')
  await enter('#password', 'test-password')
  await act(async () => {
    element('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  })
}

function loginBodies(): Array<{ username: string; password: string; device_id: string; device_name: string }> {
  return requests.filter(({ path }) => path === '/auth/login').map(({ init }) => JSON.parse(String(init.body)))
}

function anonymousRestore({ path }: Request): Response | undefined {
  if (path === '/auth/refresh') return errorResponse('invalid or expired refresh token', 401)
}

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}

test('restoration shows loading until account data arrives, then starts realtime', async () => {
  const account = deferredResponse()
  respond = ({ path }) => path === '/me' ? account.promise : undefined
  await renderApp()
  assert.match(container.textContent!, /Restoring your secure session/)
  assert.equal(starts, 0)
  await act(async () => account.resolve(Response.json(user)))
  assert.ok(container.querySelector('.shell'))
  assert.equal(starts, 1)
})

test('a missing refresh cookie restores the anonymous screen without an expiry warning', async () => {
  respond = anonymousRestore
  await renderApp()
  assert.equal(element('#auth-title').textContent, 'Welcome back')
  assert.equal(container.querySelector('[role="alert"]'), null)
  assert.equal(starts, 0)
  assert.equal(requests.some(({ path }) => path === '/me'), false)
})

test('a restore server failure displays the error on the anonymous screen', async () => {
  respond = ({ path }) => path === '/auth/refresh' ? errorResponse('Server unavailable', 503) : undefined
  await renderApp()
  assert.equal(element('[role="alert"]').textContent, 'Server unavailable')
  assert.equal(starts, 0)
})

test('revoked-device login replaces the persisted identity and retries once before loading the account', async () => {
  respond = (request) => {
    if (request.path === '/auth/login' && loginBodies().length === 1) {
      return errorResponse('device is revoked', 403)
    }
    return anonymousRestore(request)
  }
  await renderApp()
  await submitCredentials()
  const attempts = loginBodies()
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0].device_id, identity.id)
  const replacement = JSON.parse(localStorage.getItem('messenger.device')!)
  assert.notEqual(replacement.id, identity.id)
  assert.deepEqual(attempts[1], {
    username: 'alice', password: 'test-password', device_id: replacement.id, device_name: replacement.name,
  })
  assert.ok(container.querySelector('.shell'))
  assert.equal(starts, 1)
  const authPaths = requests.map(({ path }) => path).filter((path) => ['/auth/login', '/me', '/devices'].includes(path))
  assert.deepEqual(authPaths, ['/auth/login', '/auth/login', '/me', '/devices'])
})

test('revoked-device recovery uses a core error code regardless of message or transport', async () => {
  respond = anonymousRestore
  await renderApp()
  const login = apiClient.login.bind(apiClient)
  let attempts = 0
  mock.method(apiClient, 'login', async (...args: Parameters<typeof login>) => {
    attempts += 1
    if (attempts === 1) throw new ClientError('Replace this identity.', 'device_revoked')
    await login(...args)
  })
  await submitCredentials()
  assert.equal(attempts, 2)
  assert.notEqual(JSON.parse(localStorage.getItem('messenger.device')!).id, identity.id)
  assert.ok(container.querySelector('.shell'))
})

for (const [status, detail] of [[401, 'Invalid credentials'], [403, 'Account disabled'], [409, 'device is revoked']] as const) {
  test(`login error ${status}/${detail} does not replace the device or retry`, async () => {
    respond = (request) => request.path === '/auth/login' ? errorResponse(detail, status) : anonymousRestore(request)
    await renderApp()
    await submitCredentials()
    assert.equal(loginBodies().length, 1)
    assert.deepEqual(JSON.parse(localStorage.getItem('messenger.device')!), identity)
    assert.equal(element('[role="alert"]').textContent, detail)
    assert.equal(element<HTMLButtonElement>('button[type="submit"]').disabled, false)
    assert.equal(starts, 0)
  })
}

test('a rejected replacement login stops after one retry and displays the failure', async () => {
  respond = (request) => request.path === '/auth/login'
    ? errorResponse('device is revoked', 403) : anonymousRestore(request)
  await renderApp()
  await submitCredentials()
  assert.equal(loginBodies().length, 2)
  assert.equal(element('[role="alert"]').textContent, 'device is revoked')
  assert.equal(requests.some(({ path }) => path === '/me'), false)
  assert.equal(starts, 0)
})

test('registration creates the account, logs in, and loads the authenticated workspace', async () => {
  respond = anonymousRestore
  await renderApp()
  await click('[role="tab"]:nth-child(2)')
  await submitCredentials()
  assert.ok(container.querySelector('.shell'))
  assert.deepEqual(requests.map(({ path }) => path).filter((path) =>
    ['/auth/register', '/auth/login', '/me', '/devices'].includes(path)),
  ['/auth/register', '/auth/login', '/me', '/devices'])
  assert.deepEqual(JSON.parse(String(requests.find(({ path }) => path === '/auth/register')!.init.body)), {
    username: 'alice', password: 'test-password',
  })
})

for (const logoutFails of [false, true]) {
  test(`current-device revocation signs out and stops realtime${logoutFails ? ' even if cookie clearing fails' : ''}`, async () => {
    await renderApp()
    respond = ({ path }) => path === '/auth/logout' && logoutFails
      ? errorResponse('Server unavailable', 503) : undefined
    await click('.primary-nav button:nth-child(2)')
    await click('[aria-label="Revoke Test browser, this device"]')
    assert.equal(container.querySelector('.shell'), null)
    assert.equal(element('#auth-title').textContent, 'Welcome back')
    assert.equal(stops, 1)
    const revokeIndex = requests.findIndex(({ path, init }) => path === `/devices/${identity.id}` && init.method === 'DELETE')
    const logoutIndex = requests.findIndex(({ path }) => path === '/auth/logout')
    assert.ok(revokeIndex >= 0 && logoutIndex > revokeIndex)
    if (logoutFails) {
      assert.equal(element('[role="alert"]').textContent,
        'Device revoked, but its browser cookie could not be cleared: Server unavailable')
    } else {
      assert.equal(container.querySelector('[role="alert"]'), null)
    }
  })
}

test('cancelling current-device revocation leaves the session active without a delete request', async () => {
  mock.method(window, 'confirm', () => false)
  await renderApp()
  await click('.primary-nav button:nth-child(2)')
  await click('[aria-label="Revoke Test browser, this device"]')
  assert.equal(requests.some(({ init }) => init.method === 'DELETE'), false)
  assert.ok(container.querySelector('.shell'))
  assert.equal(stops, 0)
})

test('a failed current-device revocation displays the error without signing out', async () => {
  await renderApp()
  respond = ({ init }) => init.method === 'DELETE' ? errorResponse('Revocation unavailable', 503) : undefined
  await click('.primary-nav button:nth-child(2)')
  await click('[aria-label="Revoke Test browser, this device"]')
  assert.equal(element('[role="alert"]').textContent, 'Revocation unavailable')
  assert.equal(requests.some(({ path }) => path === '/auth/logout'), false)
  assert.equal(element<HTMLButtonElement>('[aria-label="Revoke Test browser, this device"]').disabled, false)
  assert.equal(stops, 0)
})

test('remote-device revocation refreshes devices and keeps the current session', async () => {
  await renderApp()
  respond = ({ path }) => path === '/devices' ? Response.json([
    devices[0], { ...devices[1], revoked_at: user.created_at },
  ]) : undefined
  await click('.primary-nav button:nth-child(2)')
  await click('[aria-label="Revoke Remote browser"]')
  assert.equal(element('.revoked-pill').textContent, 'Revoked')
  assert.equal(requests.filter(({ path }) => path === '/devices').length, 2)
  assert.equal(requests.some(({ path }) => path === '/auth/logout'), false)
  assert.equal(stops, 0)
})

for (const lateStatus of [200, 404]) {
  test(`a stale chat selection response (${lateStatus}) cannot overwrite the newer selection or preference`, async () => {
    await renderApp()
    const late = deferredResponse()
    respond = ({ path }) => path === '/chats/bob-chat' ? late.promise : undefined
    await click('.chat-list li:nth-child(1) button')
    assert.equal(element('#selected-chat-heading').textContent, 'bob')
    await click('.chat-list li:nth-child(2) button')
    await act(async () => late.resolve(lateStatus === 200
      ? Response.json(chats[0]) : errorResponse('Chat no longer available', 404)))
    assert.equal(element('#selected-chat-heading').textContent, 'carol')
    assert.equal(localStorage.getItem(lastChatKey), 'carol-chat')
    assert.equal(container.querySelector('[role="alert"]'), null)
    assert.equal(container.querySelector('.chat-list button[aria-current="page"] strong')?.textContent, 'carol')
    assert.doesNotMatch(element('.chat-list').textContent!, /Opening/)
  })
}

test('the latest failed chat selection clears the selection and stored preference', async () => {
  await renderApp()
  respond = ({ path }) => path === '/chats/bob-chat' ? errorResponse('Chat no longer available', 404) : undefined
  await click('.chat-list li:nth-child(1) button')
  assert.equal(element('#selected-chat-heading').textContent, 'Choose a conversation')
  assert.equal(localStorage.getItem(lastChatKey), null)
  assert.equal(element('[role="alert"]').textContent, 'Chat no longer available')
})

test('last-chat restoration uses the current user preference and fetches fresh chat details', async () => {
  localStorage.setItem(lastChatKey, 'carol-chat')
  localStorage.setItem('messenger.lastChat.other-user', 'bob-chat')
  respond = ({ path }) => path === '/chats/carol-chat' ? Response.json({
    ...chats[1], other_user: { ...chats[1].other_user, username: 'carol-updated' },
  }) : undefined
  await renderApp()
  assert.equal(element('#selected-chat-heading').textContent, 'carol-updated')
  assert.equal(localStorage.getItem(lastChatKey), 'carol-chat')
  assert.equal(localStorage.getItem('messenger.lastChat.other-user'), 'bob-chat')
  assert.equal(requests.filter(({ path }) => path === '/chats/carol-chat').length, 1)
  assert.equal(requests.some(({ path }) => path === '/chats/bob-chat'), false)
})

for (const storedChat of [null, 'missing-chat']) {
  test(`a ${storedChat === null ? 'missing' : 'deleted'} last chat leaves no selection and preserves other users' preferences`, async () => {
    if (storedChat) localStorage.setItem(lastChatKey, storedChat)
    localStorage.setItem('messenger.lastChat.other-user', 'bob-chat')
    await renderApp()
    assert.equal(element('#selected-chat-heading').textContent, 'Choose a conversation')
    assert.equal(localStorage.getItem(lastChatKey), null)
    assert.equal(localStorage.getItem('messenger.lastChat.other-user'), 'bob-chat')
    assert.equal(requests.some(({ path }) => path.startsWith('/chats/')), false)
  })
}

for (const refreshFails of [true, false]) {
  test(`session expiry after ${refreshFails ? 'refresh rejection' : 'a retried request returns 401'} clears the workspace and permits signing in again`, async () => {
    localStorage.setItem(lastChatKey, 'bob-chat')
    await renderApp()
    respond = ({ path }) => {
      if (path === '/devices/remote-id') return errorResponse('Session expired', 401)
      if (path === '/auth/refresh' && refreshFails) return errorResponse('Refresh expired', 401)
    }
    await click('.primary-nav button:nth-child(2)')
    await click('[aria-label="Revoke Remote browser"]')
    assert.equal(container.querySelector('.shell'), null)
    assert.equal(container.querySelector('.device-list'), null)
    assert.equal(element('[role="alert"]').textContent, 'Your session has ended. Please sign in again.')
    assert.equal(stops, 1)
    assert.equal(localStorage.getItem(lastChatKey), 'bob-chat')
    assert.equal(requests.filter(({ path }) => path === '/devices/remote-id').length, refreshFails ? 1 : 2)
    respond = () => undefined
    await submitCredentials()
    assert.ok(container.querySelector('.shell'))
    assert.equal(element('#selected-chat-heading').textContent, 'bob')
    assert.equal(container.querySelector('[role="alert"]'), null)
    assert.equal(starts, 2)
  })
}

test('logout failure still returns to sign-in with a warning and stops realtime', async () => {
  await renderApp()
  respond = ({ path }) => path === '/auth/logout' ? errorResponse('Server unavailable', 503) : undefined
  await click('.header-actions .secondary-button')
  assert.equal(container.querySelector('.shell'), null)
  assert.equal(element('[role="alert"]').textContent,
    'The server could not confirm sign-out. Reconnect and sign out again: Server unavailable')
  assert.equal(stops, 1)
})
