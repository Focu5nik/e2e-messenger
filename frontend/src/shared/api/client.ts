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
  refresh_token: string
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

const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:8000').replace(/\/$/, '')
const REFRESH_TOKEN_STORAGE_KEY = 'messenger.refresh-token'

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

  setSessionExpiredHandler(handler: () => void): void {
    this.sessionExpiredHandler = handler
  }

  hasStoredSession(): boolean {
    return localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY) !== null
  }

  async register(username: string, password: string): Promise<User> {
    return this.publicRequest<User>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  }

  async login(username: string, password: string, device: LoginDevice): Promise<void> {
    const tokens = await this.publicRequest<TokenResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username,
        password,
        device_id: device.id,
        device_name: device.name,
      }),
    })
    this.acceptTokens(tokens)
  }

  async restoreSession(): Promise<boolean> {
    if (!this.hasStoredSession()) return false
    await this.refreshAccessToken()
    return true
  }

  async logout(): Promise<void> {
    try {
      if (this.accessToken) {
        await this.authenticatedRequest<void>('/auth/logout', { method: 'POST' })
      }
    } finally {
      this.clearSession(false)
    }
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

  forgetSession(): void {
    this.clearSession(false)
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

  private refreshAccessToken(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise

    const refreshToken = localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY)
    if (!refreshToken) {
      this.clearSession(true)
      return Promise.reject(new ApiError('Your session has ended. Please sign in again.', 401))
    }

    this.refreshPromise = this.publicRequest<TokenResponse>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
      .then((tokens) => this.acceptTokens(tokens))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          this.clearSession(true)
        }
        throw error
      })
      .finally(() => {
        this.refreshPromise = null
      })

    return this.refreshPromise
  }

  private acceptTokens(tokens: TokenResponse): void {
    this.accessToken = tokens.access_token
    localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, tokens.refresh_token)
    this.scheduleRefresh(tokens.expires_in)
  }

  private scheduleRefresh(expiresInSeconds: number): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer)

    const refreshDelay = Math.max(1, expiresInSeconds - 30) * 1000
    this.refreshTimer = window.setTimeout(() => {
      this.refreshAccessToken().catch((error: unknown) => {
        if (
          this.hasStoredSession()
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
    this.accessToken = null
    localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY)
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
