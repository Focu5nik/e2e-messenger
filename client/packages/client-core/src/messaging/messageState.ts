import type { DisplayMessage } from '../domain/models.ts'

export type MessagesByChat = ReadonlyMap<string, DisplayMessage[]>

const rank = { pending: 0, accepted: 1, delivered: 2 }

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
    const prior = messages.get(message.messageId)
      ?? (command?.status === 'pending' || message.status === 'pending' ? command : undefined)
    if (prior?.status && prior.status !== 'pending' && message.status === 'pending') continue
    const status = prior?.status && message.status && rank[prior.status] > rank[message.status] ? prior.status : message.status ?? prior?.status
    const next = { ...prior, ...message, ...(prior ? { createdAt: prior.createdAt } : {}), ...(status ? { status } : {}) }
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
  return changed ? [...messages.values()].sort((a, b) => {
    const aKey = a.historyId ?? commandKey(a) ?? a.messageId
    const bKey = b.historyId ?? commandKey(b) ?? b.messageId
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : aKey < bKey ? -1 : aKey > bKey ? 1 : 0
  }) : current
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
