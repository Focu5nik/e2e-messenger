import type { ClientEvent, MailboxEnvelope, MailboxPage, RealtimeGateway, SendMessageRequest, SentMessage } from '@secure-messenger/client-core'
import { mapServerEvent } from './mappers.ts'
import { ApiError } from './errors.ts'

export interface SocketAuth {
  getWebSocketUrl(): string
  getAccessToken(refresh?: boolean): Promise<string>
  onSessionCleared(handler: () => void): () => void
}

type PendingSend = {
  resolve: (message: SentMessage) => void
  reject: (error: Error) => void
  timer: number
}
type PendingSync = { resolve: (page: MailboxPage) => void; reject: (error: Error) => void; timer: number }

export class WebSocketManager implements RealtimeGateway {
  private readonly auth: SocketAuth
  private readonly createSocket: (url: string) => WebSocket
  private socket: WebSocket | null = null
  private active = false
  private authenticated = false
  private generation = 0
  private retries = 0
  private reconnectTimer: number | null = null
  private authTimer: number | null = null
  private unsubscribeSession: (() => void) | null = null
  private messageHandlers = new Set<(envelope: MailboxEnvelope) => void>()
  private readyHandlers = new Set<() => void>()
  private pending = new Map<string, PendingSend>()
  private pendingSync = new Map<string, PendingSync>()

  constructor(auth: SocketAuth, createSocket = (url: string) => new WebSocket(url)) {
    this.auth = auth
    this.createSocket = createSocket
  }

  get ready(): boolean {
    return this.authenticated && this.socket?.readyState === 1
  }

  start(): void {
    if (this.active) return
    this.active = true
    this.unsubscribeSession = this.auth.onSessionCleared(() => this.stop())
    void this.connect(false)
  }

  stop(): void {
    this.active = false
    this.generation += 1
    this.authenticated = false
    this.retries = 0
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.clearAuthTimer()
    this.unsubscribeSession?.()
    this.unsubscribeSession = null
    const socket = this.socket
    this.socket = null
    socket?.close(1000)
    this.rejectPending()
  }

  onMessage(handler: (envelope: MailboxEnvelope) => void): () => void {
    this.messageHandlers.add(handler)
    return () => { this.messageHandlers.delete(handler) }
  }

  onReady(handler: () => void): () => void {
    this.readyHandlers.add(handler)
    return () => { this.readyHandlers.delete(handler) }
  }

  sendMessage(command: SendMessageRequest): Promise<SentMessage> {
    if (!this.ready) return Promise.reject(new ApiError('Real-time connection is unavailable.', 0))
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId)
        reject(new ApiError('Message confirmation timed out. Delivery is unconfirmed.', 0, null, 'delivery_unconfirmed'))
      }, 15_000)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        this.socket!.send(JSON.stringify({ type: 'message.send', request_id: requestId, data: command } satisfies ClientEvent))
      } catch {
        window.clearTimeout(timer)
        this.pending.delete(requestId)
        reject(new ApiError('Connection lost. Message delivery is unconfirmed.', 0, null, 'delivery_unconfirmed'))
      }
    })
  }

  getMailbox(afterSeq: number, limit = 100): Promise<MailboxPage> {
    if (!this.ready) return Promise.reject(new ApiError('Real-time connection is unavailable.', 0))
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingSync.delete(requestId)
        reject(new ApiError('Mailbox sync timed out. Reconnect to try again.', 0))
      }, 15_000)
      this.pendingSync.set(requestId, { resolve, reject, timer })
      try {
        this.socket!.send(JSON.stringify({ type: 'sync.request', request_id: requestId, data: { after_seq: afterSeq, limit } } satisfies ClientEvent))
      } catch {
        window.clearTimeout(timer)
        this.pendingSync.delete(requestId)
        reject(new ApiError('Connection lost during mailbox sync.', 0))
      }
    })
  }

  private async connect(refresh: boolean): Promise<void> {
    const generation = ++this.generation
    try {
      const accessToken = await this.auth.getAccessToken(refresh)
      if (!this.active || generation !== this.generation) return
      const socket = this.createSocket(this.auth.getWebSocketUrl())
      this.socket = socket
      const current = () => this.active && generation === this.generation && this.socket === socket
      this.authTimer = window.setTimeout(() => {
        if (current()) socket.close(4000, 'Authentication timed out')
      }, 10_000)
      socket.onopen = () => {
        if (current()) socket.send(JSON.stringify({ type: 'auth', access_token: accessToken } satisfies ClientEvent))
      }
      socket.onmessage = (event) => {
        if (!current() || typeof event.data !== 'string') return
        let frame: ReturnType<typeof mapServerEvent>
        try { frame = mapServerEvent(JSON.parse(event.data)) } catch { return }
        if (!frame || typeof frame !== 'object') return
        if (frame.type === 'auth.ok') {
          if (this.authenticated) return
          this.clearAuthTimer()
          this.authenticated = true
          this.retries = 0
          for (const handler of this.readyHandlers) handler()
        } else if (this.authenticated && frame.type === 'message.new' && frame.data) {
          for (const handler of this.messageHandlers) handler(frame.data)
        } else if (this.authenticated && (frame.type === 'sync.response' || frame.type === 'error')
          && frame.request_id && this.pendingSync.has(frame.request_id)) {
          const pending = this.pendingSync.get(frame.request_id)!
          this.pendingSync.delete(frame.request_id)
          window.clearTimeout(pending.timer)
          if (frame.type === 'sync.response') pending.resolve(frame.data)
          else pending.reject(new ApiError(frame.error.message, frame.error.status, frame.error.code))
        } else if (this.authenticated && (frame.type === 'message.accepted' || frame.type === 'error')) {
          const requestId = frame.request_id
          const pending = requestId ? this.pending.get(requestId) : undefined
          if (!pending || !requestId) return
          if (frame.type === 'error' && !frame.error) return
          this.pending.delete(requestId)
          window.clearTimeout(pending.timer)
          if (frame.type === 'message.accepted') pending.resolve(frame.data)
          else pending.reject(new ApiError(frame.error.message, frame.error.status, frame.error.code))
        }
      }
      socket.onerror = () => {
        // Browsers follow connection errors with close; reconnect is scheduled there.
      }
      socket.onclose = (event) => {
        if (!current()) return
        this.socket = null
        this.authenticated = false
        this.clearAuthTimer()
        this.rejectPending()
        if ([4001, 4403, 1008].includes(event.code)) this.stop()
        else this.scheduleReconnect(event.code === 4401)
      }
    } catch (error) {
      if (!this.active || generation !== this.generation) return
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) this.stop()
      else this.scheduleReconnect(refresh)
    }
  }

  private scheduleReconnect(refresh: boolean): void {
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.retries++, 6))
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      if (this.active) void this.connect(refresh)
    }, delay)
  }

  private clearAuthTimer(): void {
    if (this.authTimer !== null) window.clearTimeout(this.authTimer)
    this.authTimer = null
  }

  private rejectPending(): void {
    for (const pending of this.pendingSync.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(new ApiError('Connection lost during mailbox sync.', 0))
    }
    this.pendingSync.clear()
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(new ApiError('Connection lost. Message delivery is unconfirmed.', 0, null, 'delivery_unconfirmed'))
    }
    this.pending.clear()
  }
}

