import type { DisplayMessage } from '@secure-messenger/client-core'

type MessageRowProps = {
  message: DisplayMessage
  rowKey: string
  top: number
  own: boolean
  sending: boolean
  retrying: boolean
  peerLastReadSeq?: number
  retryMessage(id: string): Promise<void>
}

export function MessageRow({ message, rowKey, top, own, sending, retrying, peerLastReadSeq = 0, retryMessage }: MessageRowProps) {
  const status = own && message.chatSeq && message.chatSeq <= peerLastReadSeq ? 'read' : message.status
  const label = status === 'accepted' ? 'Sent' : status ? status[0].toUpperCase() + status.slice(1) : ''
  function handleRetry() {
    void retryMessage(message.clientMessageId!)
  }

  return <li data-key={rowKey} className={own ? 'message own' : 'message received'}
    style={{ position: 'absolute', top, right: own ? 0 : undefined, left: own ? undefined : 0 }}>
    <div>
      <p data-read-seq={!own && message.chatSeq ? message.chatSeq : undefined}>{message.content}</p>
      <div className="message-meta">
        <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time>
        {own && status && <small aria-label="Message status">{label}</small>}
        {own && status === 'pending' && message.clientMessageId && !sending &&
          <button type="button" className="message-retry" aria-label="Retry sending message"
            disabled={retrying} aria-busy={retrying} onClick={handleRetry}>Retry</button>}
      </div>
    </div>
  </li>
}
