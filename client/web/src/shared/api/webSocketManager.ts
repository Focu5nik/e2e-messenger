import type { ChatReadCursor, ClientEvent, MailboxEnvelope, MailboxPage, MessageEnvelope, RealtimeGateway, SendMessageRequest, SentMessage } from '@secure-messenger/client-core'
import { mapServerEvent } from './mappers.ts'
import { ApiError } from './errors.ts'

export interface SocketAuth {
  getWebSocketUrl(): string
  getAccessToken(refresh?: boolean): Promise<string>
  onSessionCleared(handler: () => void): () => void
}

type PendingRequest<T> = {
  resolve: (data: T) => void
  reject: (error: Error) => void
  timer: number
}

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
  private deliveredHandlers = new Set<(envelope: MessageEnvelope) => void>()
  private pendingAck = new Map<string, PendingRequest<MessageEnvelope>>()
  private readHandlers = new Set<(cursor: ChatReadCursor) => void>()
  private pendingRead = new Map<string, PendingRequest<ChatReadCursor>>()
  private readyHandlers = new Set<() => void>()
  private pending = new Map<string, PendingRequest<SentMessage>>()
  private pendingSync = new Map<string, PendingRequest<MailboxPage>>()

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

  onDelivered(handler: (envelope: MessageEnvelope) => void): () => void {
    this.deliveredHandlers.add(handler)
    return () => { this.deliveredHandlers.delete(handler) }
  }

  onReadCursor(handler: (cursor: ChatReadCursor) => void): () => void {
    this.readHandlers.add(handler)
    return () => { this.readHandlers.delete(handler) }
  }

  advanceReadCursor(chatId: string, lastReadSeq: number): Promise<ChatReadCursor> {
    return this.request(this.pendingRead,
      requestId => ({ type: 'chat.read', request_id: requestId, data: { chat_id: chatId, last_read_seq: lastReadSeq } }),
      () => new ApiError('Read confirmation timed out.', 0),
      () => new ApiError('Connection lost during read confirmation.', 0))
  }

  acknowledgeEnvelope(envelopeId: string): Promise<MessageEnvelope> {
    return this.request(
      this.pendingAck,
      requestId => ({ type: 'message.delivered', request_id: requestId, data: { envelope_id: envelopeId } }),
      () => new ApiError('Delivery acknowledgment timed out.', 0),
      () => new ApiError('Connection lost during delivery acknowledgment.', 0),
    )
  }

  sendMessage(command: SendMessageRequest): Promise<SentMessage> {
    return this.request(
      this.pending,
      requestId => ({ type: 'message.send', request_id: requestId, data: command }),
      () => new ApiError('Message confirmation timed out. Delivery is unconfirmed.', 0, null, 'delivery_unconfirmed'),
      () => new ApiError('Connection lost. Message delivery is unconfirmed.', 0, null, 'delivery_unconfirmed'),
    )
  }

  getMailbox(afterSeq: number, limit = 100): Promise<MailboxPage> {
    return this.request(
      this.pendingSync,
      requestId => ({ type: 'sync.request', request_id: requestId, data: { after_seq: afterSeq, limit } }),
      () => new ApiError('Mailbox sync timed out. Reconnect to try again.', 0),
      () => new ApiError('Connection lost during mailbox sync.', 0),
    )
  }

  private request<T>(
    requests: Map<string, PendingRequest<T>>,
    createEvent: (requestId: string) => ClientEvent,
    timeoutError: () => ApiError,
    connectionLostError: () => ApiError,
  ): Promise<T> {
    if (!this.ready) return Promise.reject(new ApiError('Real-time connection is unavailable.', 0))
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.takePending(requests, requestId)?.reject(timeoutError())
      }, 15_000)
      requests.set(requestId, { resolve, reject, timer })
      try {
        this.socket!.send(JSON.stringify(createEvent(requestId)))
      } catch {
        this.takePending(requests, requestId)?.reject(connectionLostError())
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
        try {
          frame = mapServerEvent(JSON.parse(event.data))
        } catch {
          return
        }
        this.handleFrame(frame)
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

  private handleFrame(frame: ReturnType<typeof mapServerEvent>): void {
    if (frame.type === 'auth.ok') {
      if (this.authenticated) return
      this.clearAuthTimer()
      this.authenticated = true
      this.retries = 0
      for (const handler of this.readyHandlers) handler()
      return
    }

    if (!this.authenticated) return

    switch (frame.type) {
      case 'chat.read.updated':
        if (frame.request_id) this.takePending(this.pendingRead, frame.request_id)?.resolve(frame.data)
        else for (const handler of this.readHandlers) handler(frame.data)
        return

      case 'message.new':
        for (const handler of this.messageHandlers) handler(frame.data)
        return

      case 'message.delivered':
        if (frame.request_id) {
          this.takePending(this.pendingAck, frame.request_id)?.resolve(frame.data)
        } else {
          for (const handler of this.deliveredHandlers) handler(frame.data)
        }
        return

      case 'sync.response':
        this.takePending(this.pendingSync, frame.request_id)?.resolve(frame.data)
        return

      case 'message.accepted':
        this.takePending(this.pending, frame.request_id)?.resolve(frame.data)
        return

      case 'error': {
        const pending = this.takePending(this.pendingRead, frame.request_id)
          ?? this.takePending(this.pendingAck, frame.request_id)
          ?? this.takePending(this.pendingSync, frame.request_id)
          ?? this.takePending(this.pending, frame.request_id)
        if (!pending) return
        const { message, status, code } = frame.error
        pending.reject(new ApiError(message, status, code))
        return
      }
    }
  }

  private takePending<T>(requests: Map<string, PendingRequest<T>>, requestId?: string): PendingRequest<T> | undefined {
    if (!requestId) return
    const pending = requests.get(requestId)
    if (!pending) return
    requests.delete(requestId)
    window.clearTimeout(pending.timer)
    return pending
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
    for (const pending of this.pendingRead.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(new ApiError('Connection lost during read confirmation.', 0))
    }
    this.pendingRead.clear()
    for (const pending of this.pendingAck.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(new ApiError('Connection lost during delivery acknowledgment.', 0))
    }
    this.pendingAck.clear()
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
