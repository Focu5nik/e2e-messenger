import { AuthenticatedShell } from '../features/account'
import { AuthScreen } from '../features/auth'
import { useSessionStore } from '../shared/application/clientContext'
import { useBackendHealth } from '../shared/application/useBackendHealth'

function App() {
  const { phase, user, deviceIdentity, authError } = useSessionStore((state) => state)
  const { health, refreshHealth } = useBackendHealth()

  if (phase === 'restoring' || !deviceIdentity) {
    return (
      <main className="loading-page" aria-live="polite">
        <div className="brand-mark" aria-hidden="true">S</div>
        <p role={authError ? 'alert' : undefined}>{authError ?? 'Restoring your secure session…'}</p>
      </main>
    )
  }

  if (phase === 'anonymous' || !user) {
    return <AuthScreen device={deviceIdentity} health={health} onCheckHealth={refreshHealth} />
  }

  return (
    <AuthenticatedShell
      key={`${user.id}:${user.deviceId}:${user.sessionId}`}
      user={user}
      health={health}
      onCheckHealth={refreshHealth}
    />
  )
}

export default App
