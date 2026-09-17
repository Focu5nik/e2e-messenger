import type {
  AccountGateway, ChatGateway, MessagingGateway, SessionGateway,
  CredentialsRequest, CurrentUser, DestinationDevice, Device, DirectChat, LoginDevice,
  LoginRequest, MailboxPage, SendMessageRequest, SentMessage, TokenResponse, User,
} from '@secure-messenger/client-core'
import {
  mapCurrentUser, mapDestinationDevice, mapDevice, mapDirectChat, mapEmpty, mapError,
  mapList, mapMailboxPage, mapSentMessage, mapTokens, mapUser,
} from './mappers.ts'
import { ApiError } from './errors.ts'

const API_URL = (import.meta.env?.VITE_API_URL ?? 'http://localhost:8000').replace(/\/$/, '')
const REFRESH_LOCK_NAME = 'secure-messenger:auth-refresh'
const LEGACY_REFRESH_TOKEN_STORAGE_KEY = 'messenger.refresh-token'

function clearLegacyRefreshTokenStorage(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(LEGACY_REFRESH_TOKEN_STORAGE_KEY)
    }
  } catch {
    // Storage can be unavailable; this client never reads or writes the legacy token.
  }
}

async function parseError(response: Response, login: boolean): Promise<ApiError> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    // The HTTP status still provides a useful fallback when the body is empty.
  }
  const { message, code } = mapError(payload, `Request failed (${response.status})`)
  return new ApiError(message, response.status, code, login && response.status === 401 ? 'invalid_credentials' : undefined)
}

async function fetchApi(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_URL}${path}`, init)
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0)
  }
}

// Web gateway adapter: cookie authentication, tokens, timers, and locks stay here.
export class ApiClient implements SessionGateway, AccountGateway, ChatGateway, MessagingGateway {
  private accessToken: string | null = null
  private refreshPromise: Promise<void> | null = null
  private refreshTimer: number | null = null
  private sessionExpiredHandlers = new Set<() => void>()
  private sessionRevision = 0
  private sessionClearedHandlers = new Set<() => void>()

  constructor() {
    clearLegacyRefreshTokenStorage()
  }

  onSessionExpired(handler: () => void): () => void {
    this.sessionExpiredHandlers.add(handler)
    return () => { this.sessionExpiredHandlers.delete(handler) }
  }

  onSessionCleared(handler: () => void): () => void {
    this.sessionClearedHandlers.add(handler)
    return () => { this.sessionClearedHandlers.delete(handler) }
  }

  getWebSocketUrl(): string {
    const url = new URL(`${API_URL}/ws`, window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.toString()
  }

  async getAccessToken(refresh = false): Promise<string> {
    const revision = this.sessionRevision
    if (refresh || !this.accessToken) await this.refreshAccessToken()
    if (revision !== this.sessionRevision || !this.accessToken) {
      throw new ApiError('Your session has ended. Please sign in again.', 401)
    }
    return this.accessToken
  }

  async register(username: string, password: string): Promise<User> {
    return this.publicRequest(mapUser, '/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password } satisfies CredentialsRequest),
    })
  }

  async login(username: string, password: string, device: LoginDevice): Promise<void> {
    const revision = this.sessionRevision
    await this.withRefreshCookieLock(async () => {
      if (revision !== this.sessionRevision) {
        throw new ApiError('Your session has ended. Please sign in again.', 401)
      }
      const tokens = await this.publicRequest(mapTokens, '/auth/login', {
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({
          username,
          password,
          device_id: device.id,
          device_name: device.name,
        } satisfies LoginRequest),
      })
      if (revision !== this.sessionRevision) {
        throw new ApiError('Your session has ended. Please sign in again.', 401)
      }
      this.clearSession(false)
      this.acceptTokens(tokens)
    })
  }

  async restoreSession(): Promise<boolean> {
    try {
      await this.refreshAccessToken(false)
      return this.accessToken !== null
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return false
      throw error
    }
  }

  async logout(): Promise<void> {
    this.clearSession(false)
    await this.withRefreshCookieLock(() => this.publicRequest(mapEmpty, '/auth/logout', {
      method: 'POST',
      credentials: 'include',
    }))
  }

  getCurrentUser(): Promise<CurrentUser> {
    return this.authenticatedRequest(mapCurrentUser, '/me')
  }

  getDevices(): Promise<Device[]> {
    return this.authenticatedRequest((value) => mapList(value, mapDevice), '/devices')
  }

  revokeDevice(deviceId: string): Promise<void> {
    return this.authenticatedRequest(mapEmpty, `/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
    })
  }

  searchUsers(search: string): Promise<User[]> {
    const query = new URLSearchParams({ search })
    return this.authenticatedRequest((value) => mapList(value, mapUser), `/users?${query.toString()}`)
  }

  getChats(): Promise<DirectChat[]> {
    return this.authenticatedRequest((value) => mapList(value, mapDirectChat), '/chats')
  }

  getChat(chatId: string): Promise<DirectChat> {
    return this.authenticatedRequest(mapDirectChat, `/chats/${encodeURIComponent(chatId)}`)
  }

  createDirectChat(userId: string): Promise<DirectChat> {
    return this.authenticatedRequest(mapDirectChat,
      `/chats/direct/${encodeURIComponent(userId)}`,
      { method: 'POST' },
    )
  }

  getDestinationDevices(chatId: string): Promise<DestinationDevice[]> {
    return this.authenticatedRequest((value) => mapList(value, mapDestinationDevice),
      `/chats/${encodeURIComponent(chatId)}/destination-devices`,
    )
  }

  sendMessage(command: SendMessageRequest): Promise<SentMessage> {
    return this.authenticatedRequest(mapSentMessage, '/messages', {
      method: 'POST',
      body: JSON.stringify(command),
    })
  }

  getMailbox(afterSeq: number, limit = 100): Promise<MailboxPage> {
    const query = new URLSearchParams({
      after_seq: String(afterSeq),
      limit: String(limit),
    })
    return this.authenticatedRequest(mapMailboxPage, `/messages/mailbox?${query.toString()}`)
  }

  private async publicRequest<T>(map: (value: unknown) => T, path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchApi(path, {
      ...init,
      headers: this.headers(init.headers, false, init.body !== undefined),
    })

    return this.readResponse(response, map, path === '/auth/login')
  }

  private async authenticatedRequest<T>(
    map: (value: unknown) => T,
    path: string,
    init: RequestInit = {},
    retryAfterRefresh = true,
  ): Promise<T> {
    if (!this.accessToken) {
      await this.refreshAccessToken()
    }

    let response = await fetchApi(path, {
      ...init,
      headers: this.headers(init.headers, true, init.body !== undefined),
    })

    if (response.status === 401 && retryAfterRefresh) {
      await this.refreshAccessToken()
      response = await fetchApi(path, {
        ...init,
        headers: this.headers(init.headers, true, init.body !== undefined),
      })
    }

    if (response.status === 401) this.clearSession(true)
    return this.readResponse(response, map)
  }

  private headers(headers: HeadersInit | undefined, authenticated: boolean, hasBody: boolean): Headers {
    const result = new Headers(headers)
    if (hasBody) result.set('Content-Type', 'application/json')
    if (authenticated && this.accessToken) {
      result.set('Authorization', `Bearer ${this.accessToken}`)
    }
    return result
  }

  private async readResponse<T>(response: Response, map: (value: unknown) => T, login = false): Promise<T> {
    if (!response.ok) throw await parseError(response, login)
    try {
      return map(response.status === 204 ? undefined : await response.json())
    } catch {
      throw new ApiError('The server returned an invalid response.', response.status, null, 'invalid_response')
    }
  }

  private refreshAccessToken(notifyOnFailure = true): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise

    const sessionRevision = this.sessionRevision
    const refresh = () => this.publicRequest(mapTokens, '/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    })
    this.refreshPromise = this.withRefreshCookieLock(refresh)
      .then((tokens) => {
        if (sessionRevision === this.sessionRevision) this.acceptTokens(tokens)
      })
      .catch((error: unknown) => {
        if (sessionRevision !== this.sessionRevision) return
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          this.clearSession(notifyOnFailure)
        }
        throw error
      })
      .finally(() => {
        this.refreshPromise = null
      })

    return this.refreshPromise
  }

  private withRefreshCookieLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockManager = typeof navigator === 'undefined' ? undefined : navigator.locks
    return lockManager ? lockManager.request(REFRESH_LOCK_NAME, operation) : operation()
  }

  private acceptTokens(tokens: TokenResponse): void {
    this.accessToken = tokens.access_token
    this.scheduleRefresh(tokens.expires_in)
  }

  private scheduleRefresh(expiresInSeconds: number): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)

    const refreshDelay = Math.max(1, expiresInSeconds - 30) * 1000
    this.refreshTimer = window.setTimeout(() => {
      this.refreshAccessToken().catch((error: unknown) => {
        if (
          this.accessToken !== null
          && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500)
        ) {
          this.refreshTimer = window.setTimeout(() => {
            void this.refreshAccessToken().catch(() => undefined)
          }, 30_000)
        }
      })
    }, refreshDelay)
  }

  private clearSession(notify: boolean): void {
    this.sessionRevision += 1
    this.accessToken = null
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    for (const handler of this.sessionClearedHandlers) handler()
    if (notify) {
      for (const handler of this.sessionExpiredHandlers) handler()
    }
  }
}

export const apiClient = new ApiClient()

export async function checkBackendHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/health`)
    return response.ok
  } catch {
    return false
  }
}
