import type { DisplayMessage } from '@secure-messenger/client-core'

type MessageRowProps = {
  message: DisplayMessage
  rowKey: string
  top: number
  own: boolean
  sending: boolean
  retrying: boolean
  retryMessage(id: string): Promise<void>
}

export function MessageRow({ message, rowKey, top, own, sending, retrying, retryMessage }: MessageRowProps) {
  function handleRetry() {
    void retryMessage(message.clientMessageId!)
  }

  return <li data-key={rowKey} className={own ? 'message own' : 'message received'}
    style={{ position: 'absolute', top, right: own ? 0 : undefined, left: own ? undefined : 0 }}>
    <div>
      <p>{message.content}</p>
      <div className="message-meta">
        <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time>
        {own && message.status && <small aria-label="Message status">{message.status}</small>}
        {own && message.status === 'pending' && message.clientMessageId && !sending &&
          <button type="button" className="message-retry" aria-label="Retry sending message"
            disabled={retrying} aria-busy={retrying} onClick={handleRetry}>Retry</button>}
      </div>
    </div>
  </li>
}
