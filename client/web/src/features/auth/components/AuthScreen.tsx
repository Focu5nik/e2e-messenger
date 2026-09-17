import type { DeviceIdentity } from '@secure-messenger/client-core'
import { useState, type FormEvent } from 'react'
import { useSessionStore } from '../../../shared/application/clientContext'

type AuthMode = 'login' | 'register'

type AuthScreenProps = {
  device: DeviceIdentity
  health: 'checking' | 'online' | 'offline'
  onCheckHealth: () => void
}

export function AuthScreen({
  device,
  health,
  onCheckHealth,
}: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const { authError: error, submitting, login, register, clearAuthError } = useSessionStore((state) => state)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (mode === 'register') {
      if (await register(username, password)) setMode('login')
    } else {
      await login(username, password)
    }
  }

  function selectMode(nextMode: AuthMode) {
    setMode(nextMode)
    clearAuthError()
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="brand-mark" aria-hidden="true">S</div>
        <p className="eyebrow">Secure Messenger</p>
        <h1 id="auth-title">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
        <p className="auth-intro">
          {mode === 'login'
            ? 'Sign in to continue on this device.'
            : 'Your account will be linked to this browser as a trusted device.'}
        </p>

        <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            className={mode === 'login' ? 'active' : ''}
            onClick={() => selectMode('login')}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            className={mode === 'register' ? 'active' : ''}
            onClick={() => selectMode('register')}
          >
            Register
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <label htmlFor="username">Username</label>
          <input
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            minLength={3}
            maxLength={64}
            required
            autoFocus
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />

          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={8}
            maxLength={128}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />

          {error && <p className="form-error" role="alert">{error}</p>}

          <button className="primary-button" type="submit" disabled={submitting}>
            {submitting ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div className="device-note">
          <span className="device-dot" aria-hidden="true" />
          <span><strong>This device</strong><small>{device.name}</small></span>
        </div>
      </section>

      <button className={`health-status ${health}`} type="button" onClick={onCheckHealth}>
        <span aria-hidden="true" /> Backend {health}
      </button>
    </main>
  )
}
