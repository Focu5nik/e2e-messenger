import type { DisplayMessage } from '../domain/models.ts'

export function mergeMessages(current: DisplayMessage[], incoming: DisplayMessage[]): DisplayMessage[] {
  const messages = new Map(current.map((message) => [message.messageId, message]))
  for (const message of incoming) messages.set(message.messageId, message)
  return [...messages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
