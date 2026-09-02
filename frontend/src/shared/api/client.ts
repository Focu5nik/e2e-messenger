export type User = {
  id: string
  username: string
  status: string
  created_at: string
}

export type CurrentUser = User & {
  device_id: string
  session_id: string
}

export type Device = {
  id: string
  name: string
  protocol_version: number
  created_at: string
  last_seen_at: string
  revoked_at: string | null
  is_current: boolean
}

type TokenResponse = {
  access_token: string
  token_type: 'bearer'
  expires_in: number
}

type LoginDevice = {
  id: string
  name: string
}

type ErrorDetail = string | Array<{ loc?: Array<string | number>; msg?: string }>

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

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

function errorMessage(detail: ErrorDetail | undefined, fallback: string): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const messages = detail.flatMap((item) => (item.msg ? [item.msg] : []))
    if (messages.length > 0) return messages.join('. ')
  }
  return fallback
}

async function parseError(response: Response): Promise<ApiError> {
  let detail: ErrorDetail | undefined

  try {
    const payload = (await response.json()) as { detail?: ErrorDetail }
    detail = payload.detail
  } catch {
    // The HTTP status still provides a useful fallback when the body is empty.
  }

  return new ApiError(errorMessage(detail, `Request failed (${response.status})`), response.status)
}

async function fetchApi(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_URL}${path}`, init)
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0)
  }
}

export class ApiClient {
  private accessToken: string | null = null
  private refreshPromise: Promise<void> | null = null
  private refreshTimer: number | null = null
  private sessionExpiredHandler: (() => void) | null = null
  private sessionRevision = 0

  constructor() {
    clearLegacyRefreshTokenStorage()
  }

  setSessionExpiredHandler(handler: () => void): void {
    this.sessionExpiredHandler = handler
  }

  async register(username: string, password: string): Promise<User> {
    return this.publicRequest<User>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  }

  async login(username: string, password: string, device: LoginDevice): Promise<void> {
    await this.withRefreshCookieLock(async () => {
      const tokens = await this.publicRequest<TokenResponse>('/auth/login', {
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({
          username,
          password,
          device_id: device.id,
          device_name: device.name,
        }),
      })
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
    await this.withRefreshCookieLock(() => this.publicRequest<void>('/auth/logout', {
      method: 'POST',
      credentials: 'include',
    }))
  }

  getCurrentUser(): Promise<CurrentUser> {
    return this.authenticatedRequest<CurrentUser>('/me')
  }

  getDevices(): Promise<Device[]> {
    return this.authenticatedRequest<Device[]>('/devices')
  }

  revokeDevice(deviceId: string): Promise<void> {
    return this.authenticatedRequest<void>(`/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
    })
  }

  private async publicRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchApi(path, {
      ...init,
      headers: this.headers(init.headers, false, init.body !== undefined),
    })

    return this.readResponse<T>(response)
  }

  private async authenticatedRequest<T>(
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
    return this.readResponse<T>(response)
  }

  private headers(headers: HeadersInit | undefined, authenticated: boolean, hasBody: boolean): Headers {
    const result = new Headers(headers)
    if (hasBody) result.set('Content-Type', 'application/json')
    if (authenticated && this.accessToken) {
      result.set('Authorization', `Bearer ${this.accessToken}`)
    }
    return result
  }

  private async readResponse<T>(response: Response): Promise<T> {
    if (!response.ok) throw await parseError(response)
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  private refreshAccessToken(notifyOnFailure = true): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise

    const sessionRevision = this.sessionRevision
    const refresh = () => this.publicRequest<TokenResponse>('/auth/refresh', {
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
    if (notify) this.sessionExpiredHandler?.()
  }
}

export const apiClient = new ApiClient()

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

export async function checkBackendHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/health`)
    return response.ok
  } catch {
    return false
  }
}
