import type { DisplayMessage } from '../domain/models.ts'

export type MessagesByChat = ReadonlyMap<string, DisplayMessage[]>

const rank = { pending: 0, accepted: 1, delivered: 2, read: 3 }

function commandKey(message: DisplayMessage): string | undefined {
  return message.clientMessageId && message.senderDeviceId
    ? JSON.stringify([message.chatId, message.senderDeviceId, message.clientMessageId]) : undefined
}

function equalMessages(a: DisplayMessage, b: DisplayMessage): boolean {
  return (Object.keys(b) as Array<keyof DisplayMessage>).every(key => {
    if (key !== 'deliveries') return a[key] === b[key]
    return a.deliveries === b.deliveries || (a.deliveries?.length === b.deliveries?.length
      && !!a.deliveries?.every((item, index) => item.deviceId === b.deliveries![index].deviceId
        && item.deliveredAt === b.deliveries![index].deliveredAt))
  })
}

function selectStatus(previous: DisplayMessage['status'], incoming: DisplayMessage['status']): DisplayMessage['status'] {
  if (!incoming) return previous
  if (previous && rank[previous] > rank[incoming]) return previous
  return incoming
}

function compareMessages(a: DisplayMessage, b: DisplayMessage): number {
  if (a.createdAt < b.createdAt) return -1
  if (a.createdAt > b.createdAt) return 1

  const aKey = a.historyId ?? commandKey(a) ?? a.messageId
  const bKey = b.historyId ?? commandKey(b) ?? b.messageId
  if (aKey < bKey) return -1
  if (aKey > bKey) return 1
  return 0
}

export function mergeMessages(current: DisplayMessage[], incoming: DisplayMessage[]): DisplayMessage[] {
  if (!incoming.length) return current
  const messages = new Map(current.map((message) => [message.messageId, message]))
  const commands = new Map<string, DisplayMessage>()
  for (const message of current) {
    const key = commandKey(message)
    if (key) commands.set(key, message)
  }
  let changed = false
  for (const message of incoming) {
    const key = commandKey(message)
    const command = key ? commands.get(key) : undefined
    let prior = messages.get(message.messageId)
    if (!prior && (command?.status === 'pending' || message.status === 'pending')) {
      prior = command
    }
    if (prior?.status && prior.status !== 'pending' && message.status === 'pending') continue
    const status = selectStatus(prior?.status, message.status)
    const next = { ...prior, ...message }
    if (prior) next.createdAt = prior.createdAt
    if (status) next.status = status
    if (prior && equalMessages(prior, next)) continue
    if (prior) {
      messages.delete(prior.messageId)
      const priorKey = commandKey(prior)
      if (priorKey && commands.get(priorKey) === prior) commands.delete(priorKey)
    }
    messages.set(message.messageId, next)
    if (key) commands.set(key, next)
    changed = true
  }
  if (!changed) return current
  return [...messages.values()].sort(compareMessages)
}

// Clone and merge only affected conversations; other chat selectors stay stable.
export function mergeMessagesByChat(current: MessagesByChat, incoming: DisplayMessage[]): MessagesByChat {
  const grouped = new Map<string, DisplayMessage[]>()
  for (const message of incoming) {
    const messages = grouped.get(message.chatId)
    if (messages) messages.push(message)
    else grouped.set(message.chatId, [message])
  }
  let next: Map<string, DisplayMessage[]> | undefined
  for (const [chatId, messages] of grouped) {
    const previous = current.get(chatId) ?? []
    const merged = mergeMessages(previous, messages)
    if (merged === previous) continue
    next ??= new Map(current)
    next.set(chatId, merged)
  }
  return next ?? current
}
