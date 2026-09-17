import type { CurrentUser } from '@secure-messenger/client-core'
import { ChatSidebar } from './ChatSidebar'
import { ChatConversation } from './ChatConversation'

export function ChatWorkspace({ user }: { user: CurrentUser }) {
  return (
    <div className="chat-layout">
      <ChatSidebar user={user} />
      <ChatConversation user={user} />
    </div>
  )
}
