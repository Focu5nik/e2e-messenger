import { ChatPreferencesService, createChatStore, createSessionStore, DeviceIdentityService, MessengerService, PlaintextMessageCodec } from '@secure-messenger/client-core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App.tsx'
import { apiClient, checkBackendHealth } from './shared/api/client.ts'
import { WebSocketManager } from './shared/api/webSocketManager.ts'
import { browserDeviceDescription } from './shared/platform/deviceDescription.ts'
import { browserIdGenerator, browserTextEncoding } from './shared/platform/messaging.ts'
import { browserChatPreferencesStore, browserDeviceIdentityStore } from './shared/platform/storage.ts'
import { WebClientProvider } from './shared/application/WebClientProvider.tsx'
import './app/styles.css'

const realtime = new WebSocketManager(apiClient)
const identities = new DeviceIdentityService(browserDeviceIdentityStore, browserIdGenerator, browserDeviceDescription)
const preferences = new ChatPreferencesService(browserChatPreferencesStore)
const session = createSessionStore({ session: apiClient, account: apiClient, identities })
const messenger = new MessengerService(apiClient, new PlaintextMessageCodec(browserTextEncoding), browserIdGenerator, realtime)
const chatStore = createChatStore({ chats: apiClient, messenger, preferences })

const client = { session, chatStore, realtime, checkHealth: checkBackendHealth }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WebClientProvider client={client}>
      <App />
    </WebClientProvider>
  </StrictMode>,
)
