import { useCallback, useEffect, useState } from 'react'
import { AuthenticatedShell } from '../features/account'
import { AuthScreen, getDeviceIdentity, replaceDeviceIdentity } from '../features/auth'
import {
  apiClient,
  checkBackendHealth,
  getErrorMessage,
  type CurrentUser,
  type Device,
} from '../shared/api'

type AuthPhase = 'restoring' | 'anonymous' | 'authenticated'
type Health = 'checking' | 'online' | 'offline'

function App() {
  const [phase, setPhase] = useState<AuthPhase>('restoring')
  const [health, setHealth] = useState<Health>('checking')
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [authError, setAuthError] = useState<string | null>(null)
  const [deviceIdentity, setDeviceIdentity] = useState(getDeviceIdentity)

  const clearAuthenticatedState = useCallback((message: string | null = null) => {
    setUser(null)
    setDevices([])
    setAuthError(message)
    setPhase('anonymous')
  }, [])

  const loadAccount = useCallback(async () => {
    const [currentUser, currentDevices] = await Promise.all([
      apiClient.getCurrentUser(),
      apiClient.getDevices(),
    ])
    setUser(currentUser)
    setDevices(currentDevices)
    setAuthError(null)
    setPhase('authenticated')
  }, [])

  const refreshDevices = useCallback(async () => {
    setDevices(await apiClient.getDevices())
  }, [])

  const refreshHealth = useCallback(() => {
    setHealth('checking')
    void checkBackendHealth().then((isOnline) => setHealth(isOnline ? 'online' : 'offline'))
  }, [])

  const replaceDevice = useCallback(() => {
    const replacement = replaceDeviceIdentity()
    setDeviceIdentity(replacement)
    return replacement
  }, [])

  useEffect(() => {
    let active = true
    apiClient.setSessionExpiredHandler(() => {
      if (active) clearAuthenticatedState('Your session has ended. Please sign in again.')
    })
    refreshHealth()

    void apiClient.restoreSession()
      .then((restored) => {
        if (!active) return undefined
        return restored ? loadAccount() : setPhase('anonymous')
      })
      .catch((error: unknown) => {
        if (!active) return
        clearAuthenticatedState(
          apiClient.hasStoredSession()
            ? getErrorMessage(error)
            : 'Your session has ended. Please sign in again.',
        )
      })

    return () => {
      active = false
    }
  }, [clearAuthenticatedState, loadAccount, refreshHealth])

  if (phase === 'restoring') {
    return (
      <main className="loading-page" aria-live="polite">
        <div className="brand-mark" aria-hidden="true">S</div>
        <p>Restoring your secure session…</p>
      </main>
    )
  }

  if (phase === 'anonymous' || !user) {
    return (
      <AuthScreen
        api={apiClient}
        device={deviceIdentity}
        onReplaceDevice={replaceDevice}
        initialError={authError}
        health={health}
        onAuthenticated={loadAccount}
        onCheckHealth={refreshHealth}
      />
    )
  }

  return (
    <AuthenticatedShell
      api={apiClient}
      user={user}
      devices={devices}
      health={health}
      onDevicesChanged={refreshDevices}
      onSignedOut={() => clearAuthenticatedState()}
      onCheckHealth={refreshHealth}
    />
  )
}

export default App
